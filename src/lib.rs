// solidcraft-triage: WASM engine that ingests GitHub issue JSON and answers
// filter/sort/facet queries. Raw C ABI (no wasm-bindgen): strings cross as
// (ptr,len) via alloc/dealloc; results come back as a buffer whose first
// 4 bytes are a u32 length followed by UTF-8 JSON.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cell::RefCell;

#[derive(Deserialize)]
struct RawIssue {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    state_reason: Option<String>,
    #[serde(default)]
    labels: Vec<Label>,
    #[serde(default)]
    comments: u64,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    updated_at: String,
    #[serde(default)]
    closed_at: Option<String>,
    #[serde(default)]
    closed_by: Option<User>,
    #[serde(default)]
    user: Option<User>,
    #[serde(default)]
    html_url: String,
    // presence => it's a PR, skip it
    #[serde(default)]
    pull_request: Option<Value>,
}

#[derive(Deserialize)]
struct Label {
    name: String,
}

#[derive(Deserialize)]
struct User {
    login: String,
}

#[derive(Serialize)]
struct Row {
    n: u64,
    t: String,
    st: String,
    r: String, // state_reason: completed | not_planned | ""
    l: Vec<String>,
    c: u64,
    ca: String, // created
    ua: String, // updated
    cl: String, // closed_at
    cb: String, // closed_by
    au: String, // author
    u: String,  // url
    tb: bool,   // has a "Triage by ..." comment marker
}

#[derive(Deserialize)]
struct Query {
    #[serde(default)]
    q: String,
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    not_labels: Vec<String>,
    #[serde(default)]
    state: String, // open | closed | all
    #[serde(default)]
    reason: String, // all | completed | not_planned | none
    #[serde(default)]
    sort: String, // updated | created | comments | number
    #[serde(default)]
    triaged: String, // all | yes | no
    #[serde(default)]
    desc: Option<bool>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}

fn default_limit() -> usize {
    200
}

struct Store {
    rows: Vec<Row>,
}

thread_local! {
    static STORE: RefCell<Store> = const { RefCell::new(Store { rows: Vec::new() }) };
    static OUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn out_json(v: &impl Serialize) -> *const u8 {
    let bytes = serde_json::to_vec(v).unwrap_or_else(|_| b"{\"error\":\"serialize\"}".to_vec());
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        o.clear();
        o.extend((bytes.len() as u32).to_le_bytes());
        o.extend(bytes);
        o.as_ptr()
    })
}

fn read_str(ptr: usize, len: usize) -> String {
    let bytes = unsafe { std::slice::from_raw_parts(ptr as *const u8, len) };
    String::from_utf8_lossy(bytes).into_owned()
}

// ---- C ABI ----

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    unsafe { drop(Vec::from_raw_parts(ptr, 0, len)) }
}

/// Input: JSON array of GitHub issue objects (as returned by GET /repos/x/y/issues).
/// Appends to the store, skipping PRs. Returns {"loaded":N,"total":M}.
#[no_mangle]
pub extern "C" fn triage_load(ptr: usize, len: usize) -> *const u8 {
    let input = read_str(ptr, len);
    let raws: Vec<RawIssue> = match serde_json::from_str(&input) {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("{}", e);
            return out_json(&serde_json::json!({"error": msg}));
        }
    };
    let mut added = 0usize;
    STORE.with(|s| {
        let mut s = s.borrow_mut();
        for r in raws {
            if r.pull_request.is_some() {
                continue;
            }
            added += 1;
            s.rows.push(Row {
                n: r.number,
                t: r.title,
                st: r.state,
                r: r.state_reason.unwrap_or_default(),
                l: r.labels.into_iter().map(|l| l.name).collect(),
                c: r.comments,
                ca: r.created_at,
                ua: r.updated_at,
                cl: r.closed_at.unwrap_or_default(),
                cb: r.closed_by.map(|u| u.login).unwrap_or_default(),
                au: r.user.map(|u| u.login).unwrap_or_default(),
                u: r.html_url,
                tb: false,
            });
        }
    });
    let total = STORE.with(|s| s.borrow().rows.len());
    out_json(&serde_json::json!({"loaded": added, "total": total}))
}

#[no_mangle]
pub extern "C" fn triage_reset() {
    STORE.with(|s| s.borrow_mut().rows.clear());
}

/// Input: {"numbers":[123, ...]} — flags those issues as triaged (a "Triage by ..."
/// comment exists). Returns {"marked":N}.
#[no_mangle]
pub extern "C" fn triage_mark(ptr: usize, len: usize) -> *const u8 {
    let input = read_str(ptr, len);
    let v: serde_json::Value = match serde_json::from_str(&input) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!("{}", e);
            return out_json(&serde_json::json!({"error": msg}));
        }
    };
    let nums: std::collections::HashSet<u64> = v
        .get("numbers")
        .and_then(|n| n.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_u64()).collect())
        .unwrap_or_default();
    let mut marked = 0usize;
    STORE.with(|s| {
        for r in s.borrow_mut().rows.iter_mut() {
            if nums.contains(&r.n) {
                r.tb = true;
                marked += 1;
            }
        }
    });
    out_json(&serde_json::json!({"marked": marked}))
}

/// Input: Query JSON. Output: {rows, filtered, total, facets:{labels:[[name,count]], reasons:{...}, open, closed}}
#[no_mangle]
pub extern "C" fn triage_query(ptr: usize, len: usize) -> *const u8 {
    let input = read_str(ptr, len);
    let q: Query = match serde_json::from_str(&input) {
        Ok(q) => q,
        Err(e) => {
            let msg = format!("{}", e);
            return out_json(&serde_json::json!({"error": msg}));
        }
    };
    let ql = q.q.to_lowercase();
    let desc = q.desc.unwrap_or(true);

    STORE.with(|s| {
        let s = s.borrow();
        // pass 1: apply filters, gather facets over the filtered set
        let mut matched: Vec<&Row> = s
            .rows
            .iter()
            .filter(|r| {
                if q.state != "all" && r.st != q.state {
                    return false;
                }
                if q.triaged == "yes" && !r.tb {
                    return false;
                }
                if q.triaged == "no" && r.tb {
                    return false;
                }
                if q.reason != "all" {
                    match q.reason.as_str() {
                        "none" if !r.r.is_empty() => return false,
                        other if !other.is_empty() && other != "none" && r.r != other => {
                            return false
                        }
                        _ => {}
                    }
                }
                if !q.labels.iter().all(|l| r.l.iter().any(|x| x == l)) {
                    return false;
                }
                if q.not_labels.iter().any(|l| r.l.contains(l)) {
                    return false;
                }
                if !ql.is_empty() {
                    let hay = format!(
                        "{} {} {}",
                        r.n,
                        r.t.to_lowercase(),
                        r.l.join(" ").to_lowercase()
                    );
                    if !ql.split_whitespace().all(|w| hay.contains(w)) {
                        return false;
                    }
                }
                true
            })
            .collect();

        let mut label_counts: std::collections::HashMap<&str, usize> = Default::default();
        let mut reason_counts: std::collections::HashMap<&str, usize> = Default::default();
        let mut open = 0usize;
        let mut closed = 0usize;
        let mut triaged = 0usize;
        for r in &matched {
            for l in &r.l {
                *label_counts.entry(l.as_str()).or_insert(0) += 1;
            }
            *reason_counts.entry(r.r.as_str()).or_insert(0) += 1;
            if r.tb {
                triaged += 1;
            }
            if r.st == "open" {
                open += 1;
            } else {
                closed += 1;
            }
        }
        let mut lbl: Vec<(&&str, &usize)> = label_counts.iter().collect();
        lbl.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
        let labels: Vec<(&str, usize)> = lbl.into_iter().take(60).map(|(k, v)| (*k, *v)).collect();

        // pass 2: sort + paginate
        matched.sort_by(|a, b| match q.sort.as_str() {
            "created" => a.ca.cmp(&b.ca),
            "comments" => a.c.cmp(&b.c),
            "number" => a.n.cmp(&b.n),
            _ => a.ua.cmp(&b.ua),
        });
        if desc {
            matched.reverse();
        }
        let filtered = matched.len();
        let rows: Vec<&Row> = matched.into_iter().skip(q.offset).take(q.limit).collect();

        out_json(&serde_json::json!({
            "rows": rows,
            "filtered": filtered,
            "total": s.rows.len(),
            "facets": {
                "labels": labels,
                "reasons": reason_counts,
                "open": open,
                "closed": closed,
                "triaged": triaged
            }
        }))
    })
}
