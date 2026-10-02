// sim-eyes Studio page: plain JS, no framework. Text is always set as text (never as HTML).
const appEl = document.getElementById("app");
const crumbsEl = document.getElementById("crumbs");

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  if (value !== undefined) el.value = value;
  return el;
};

const fill = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));

/** **bold** and `code` in a message that comes from the server, as nodes. */
const rich = (text) =>
  String(text)
    .split(/(\*\*[^*]+\*\*|`[^`]+`)/)
    .map((part) => (part.startsWith("**") ? h("strong", {}, part.slice(2, -2)) : part.startsWith("`") ? h("code", {}, part.slice(1, -1)) : part));

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The request failed (${res.status}).`);
  return data;
}

const when = (iso) => (iso ? new Date(iso).toLocaleString() : "");
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const enc = encodeURIComponent;

// ---- how a step reads -------------------------------------------------------------------------------------------
const q = (s) => `"${s}"`;
export function describeStep(step) {
  if (!step) return "";
  switch (step.tool) {
    case "tap": return `Tap ${q(step.label)}${step.nth ? ` (number ${step.nth} with that name)` : ""}`;
    case "tap_at": return `Tap at ${step.x}, ${step.y}`;
    case "type": return `Type ${q(step.text)}${step.into ? ` into ${q(step.into)}` : ""}${step.submit ? " and press return" : ""}`;
    case "scroll": return `Scroll ${step.direction}${step.times ? ` ${step.times} times` : ""}`;
    case "back": return "Go back";
    case "wait": return `Wait ${step.ms / 1000} seconds`;
    case "key": return step.key === "return" ? "Press return" : "Hide the keyboard";
    case "long_press": return `Long press ${q(step.label)}`;
    case "drag": return `Drag ${q(step.from)} to ${q(step.to)}`;
    case "open": return step.reset ? "Open the app fresh" : step.relaunch ? "Restart the app" : "Open the app";
    case "look": return "Look at the screen";
    case "goal": return `Goal: ${step.goal}${step.text ? ` (may type ${q(step.text)})` : ""} · up to ${step.max_steps} actions`;
    default: return step.tool;
  }
}
const START_LABELS = { fresh: "Start: open the app fresh", relaunch: "Start: restart the app", "as-is": "Start: look at the screen as it is" };
const START_HELP = {
  fresh: "Reinstalls the app first, so its data is empty. Needs the app's bundle id; system apps such as Settings cannot be reset.",
  relaunch: "Closes the app and opens it again. Its data stays.",
  "as-is": "Starts from whatever is on the simulator's screen.",
};

const badge = (text, kind = "") => h("span", { class: `badge ${kind}` }, text);
const howBadge = (line) => {
  if (line.how === "phrase") return badge("fixed phrase");
  if (line.how === "typesafe") return badge(`AI ${line.confidence?.toFixed(2) ?? ""}`.trim(), "ai");
  if (line.how === "goal-fallback") return badge("AI unsure → goal", "warn");
  return null;
};
/** A delete that needs a second click (the label changes for four seconds), so history is not lost by a stray click. */
const confirmButton = (label, confirmLabel, onConfirm, cls = "danger") => {
  const b = h("button", { class: cls, type: "button" }, label);
  let timer;
  b.onclick = async () => {
    if (!b.dataset.armed) {
      b.dataset.armed = "1";
      b.textContent = confirmLabel;
      timer = setTimeout(() => { delete b.dataset.armed; b.textContent = label; }, 4000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    try { await onConfirm(); } catch (err) { b.disabled = false; delete b.dataset.armed; b.textContent = label; b.after(fail(err)); }
  };
  return b;
};
const statusBadge = (status) => badge({ completed: "Completed", failed: "Failed", inconclusive: "Inconclusive", error: "Error", running: "Running" }[status] ?? status, { completed: "good", failed: "bad", inconclusive: "warn", error: "bad", running: "ai" }[status] ?? "");
const verdictBadge = (v) => (v ? badge(v.result === "pass" ? "Pass" : "Fail", v.result === "pass" ? "good" : "bad") : null);

// ---- shell -----------------------------------------------------------------------------------------------------
function setCrumbs(list) {
  crumbsEl.replaceChildren(...list.map(([text, href]) => h("a", { href }, text)));
}
function mount(ctx, crumbs, ...nodes) {
  if (ctx.dead) return false;
  setCrumbs(crumbs);
  fill(appEl, ...nodes);
  return true;
}
const fail = (err) => h("p", { class: "notice bad" }, err.message);

function lightbox(src) {
  const box = h("div", { class: "lightbox", onclick: () => box.remove() }, h("img", { src }));
  document.addEventListener("keydown", function onKey(e) { if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", onKey); } });
  document.body.append(box);
}

// ---- projects ------------------------------------------------------------------------------------------------
async function projectsView(ctx) {
  const projects = await api("GET", "/api/projects");
  const msg = h("div");
  const name = h("input", { type: "text", id: "project-name", placeholder: "PDF Tools", required: true });
  const bundle = h("input", { type: "text", id: "project-app", placeholder: "com.example.pdftools" });
  const form = h("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault();
    try {
      const project = await api("POST", "/api/projects", { name: name.value, app: bundle.value });
      location.hash = `#/p/${project.slug}`;
    } catch (err) { msg.replaceChildren(fail(err)); }
  } },
    h("label", { class: "field" }, "Project name", name),
    h("label", { class: "field" }, "App bundle id (optional, the first build fills it in)", bundle),
    h("button", { class: "primary", type: "submit" }, "Create project"));
  mount(ctx, [["Projects", "#/"]],
    h("h1", {}, "Projects"),
    h("p", { class: "sub" }, "A project is one app and its test cases."),
    projects.length
      ? h("div", { class: "card" }, projects.map((p) => h("div", { class: "row" },
          h("div", { class: "grow" }, h("a", { class: "title", href: `#/p/${p.slug}` }, p.name), h("div", { class: "muted small" }, p.app || "no app yet")))))
      : h("p", { class: "muted" }, "No projects yet."),
    h("h2", {}, "New project"), h("div", { class: "panel" }, form, msg));
}

// ---- project: tests and builds ---------------------------------------------------------------------------------
async function projectView(ctx, slug) {
  const [project, tests, builds] = await Promise.all([api("GET", `/api/projects/${slug}`), api("GET", `/api/projects/${slug}/tests`), api("GET", `/api/projects/${slug}/builds`)]);
  const testMsg = h("div");
  const testName = h("input", { type: "text", id: "test-name", placeholder: "Create a folder", required: true });
  const newTest = h("form", { class: "inline", onsubmit: async (e) => {
    e.preventDefault();
    try {
      const t = await api("POST", `/api/projects/${slug}/tests`, { name: testName.value });
      location.hash = `#/p/${slug}/t/${t.slug}`;
    } catch (err) { testMsg.replaceChildren(fail(err)); }
  } }, h("label", { class: "field" }, "Test name", testName), h("button", { class: "primary", type: "submit" }, "New test"));

  const buildsBox = h("div");
  mount(ctx, [["Projects", "#/"], [project.name, `#/p/${slug}`]],
    h("h1", {}, project.name),
    h("p", { class: "sub" }, project.app ? `App: ${project.app}` : "No app yet: add a build and its bundle id is filled in."),
    h("h2", {}, "Tests"),
    tests.length
      ? h("div", { class: "card" }, tests.map((t) => h("div", { class: "row" },
          h("div", { class: "grow" }, h("a", { class: "title", href: `#/p/${slug}/t/${t.slug}` }, t.name), h("div", { class: "muted small" }, `${t.lineCount} lines · start: ${t.start}`)),
          h("span", { class: "muted small" }, when(t.savedAt)))))
      : h("p", { class: "muted" }, "No tests yet."),
    h("div", { class: "panel", style: "margin-top:12px" }, newTest, testMsg),
    h("h2", {}, "App build"),
    buildsBox);
  buildsPanel(ctx, buildsBox, slug, builds);
}

// ---- builds: drop, upload, list ------------------------------------------------------------------------------
const NOT_BUILD = "Drop a simulator `.app`, or a `.zip` / `.ipa` that holds one.";

async function walk(entry, out = []) {
  if (entry.isFile) {
    if (entry.name === ".DS_Store") return out;
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file, path: entry.fullPath.replace(/^\//, "") });
  } else {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, out);
    }
  }
  return out;
}

function sendArchive(slug, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/projects/${slug}/builds?name=${enc(file.name)}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      const data = JSON.parse(xhr.responseText || "{}");
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error("The upload failed: Studio is not answering."));
    xhr.send(file);
  });
}

async function sendFolder(slug, files, onProgress) {
  const { uploadId } = await api("POST", `/api/projects/${slug}/uploads`);
  const total = files.reduce((n, f) => n + f.file.size, 0) || 1;
  let sent = 0;
  let next = 0;
  try {
    const worker = async () => {
      while (next < files.length) {
        const { file, path } = files[next++];
        const res = await fetch(`/api/projects/${slug}/uploads/${uploadId}/${path.split("/").map(enc).join("/")}`, { method: "PUT", body: file });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The upload failed (${res.status}).`);
        sent += file.size;
        onProgress(sent / total);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    return await api("POST", `/api/projects/${slug}/builds`, { uploadId });
  } catch (err) {
    await fetch(`/api/projects/${slug}/uploads/${uploadId}`, { method: "DELETE" }).catch(() => {});
    throw err;
  }
}

function buildsPanel(ctx, box, slug, state) {
  const note = h("div");
  const bar = h("div", { class: "progress", hidden: true }, h("div"));
  let busy = false;
  const progress = (f) => { bar.hidden = false; bar.firstChild.style.width = `${Math.round(f * 100)}%`; };

  const refresh = async () => buildsPanel(ctx, box, slug, await api("GET", `/api/projects/${slug}/builds`));
  const intake = async (job) => {
    if (busy) return;
    busy = true;
    note.replaceChildren(h("p", { class: "hint" }, "Uploading…"));
    try {
      const build = await job();
      await refresh();
      box.prepend(h("p", { class: "notice good" }, `Added ${build.name} ${build.version} (${build.build}) and selected it for runs.`));
    } catch (err) {
      busy = false;
      bar.hidden = true;
      note.replaceChildren(h("p", { class: "notice bad", id: "build-refusal" }, rich(err.message)));
    }
  };
  const refuse = () => note.replaceChildren(h("p", { class: "notice bad", id: "build-refusal" }, rich(NOT_BUILD)));
  const archive = (file) => (/\.(zip|ipa)$/i.test(file.name) ? intake(() => sendArchive(slug, file, progress)) : refuse());
  const folder = (files) => (files.length && /\.app$/i.test(files[0].path.split("/")[0]) ? intake(() => sendFolder(slug, files, progress)) : refuse());

  const drop = h("div", { class: "drop", id: "drop-zone" },
    h("div", {}, "Drop a simulator ", h("strong", {}, ".app"), ", ", h("strong", {}, ".ipa"), " or ", h("strong", {}, ".zip"), " here"),
    h("div", { class: "actions" },
      h("button", { class: "link", type: "button", onclick: () => pickFile.click() }, "Choose file…"),
      h("button", { class: "link", type: "button", onclick: () => pickFolder.click() }, "Choose .app folder…")),
    bar);
  const pickFile = h("input", { type: "file", accept: ".zip,.ipa", hidden: true, id: "pick-file", onchange: () => pickFile.files[0] && archive(pickFile.files[0]) });
  const pickFolder = h("input", { type: "file", webkitdirectory: true, hidden: true, id: "pick-folder", onchange: () => folder([...pickFolder.files].map((file) => ({ file, path: file.webkitRelativePath }))) });
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    // Entries must be taken synchronously: the drag data is gone after the first await.
    const entries = [...e.dataTransfer.items].filter((i) => i.kind === "file").map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    const files = [...e.dataTransfer.files];
    if (entries.length === 1 && entries[0].isDirectory) {
      if (!/\.app$/i.test(entries[0].name)) return refuse();
      return void walk(entries[0]).then(folder, (err) => note.replaceChildren(fail(err)));
    }
    if (files.length === 1 && files[0].size > 0) return archive(files[0]);
    refuse();
  });

  const select = async (id) => {
    try { await api("PUT", `/api/projects/${slug}/build`, { id }); await refresh(); } catch (err) { note.replaceChildren(fail(err)); }
  };
  const list = state.builds.length
    ? h("div", { class: "card", style: "margin-top:12px" }, state.builds.map((b) => h("div", { class: "row" },
        h("input", { type: "radio", name: "build", checked: state.selected === b.id, "aria-label": `Use ${b.name} ${b.version} for runs`, onchange: () => select(b.id) }),
        h("div", { class: "grow" },
          h("div", { class: "title" }, `${b.name} ${b.version} (${b.build})`, state.selected === b.id ? [" ", badge("used for runs", "good")] : null),
          h("div", { class: "muted small" }, `${b.bundleId} · added ${when(b.addedAt)} · from ${b.source}`)),
        h("button", { class: "danger", type: "button", onclick: async () => { await api("DELETE", `/api/projects/${slug}/builds/${b.id}`); refresh(); } }, "Remove"))))
    : null;
  fill(box,
    state.builds.length && !state.selected ? h("p", { class: "notice" }, "No build is selected: runs use whatever copy of the app is already on the simulator.") : null,
    !state.builds.length ? h("p", { class: "notice" }, "No build yet. Every run installs the selected build on its simulator first, so a run always tests a known build.") : null,
    drop, pickFile, pickFolder, note, list);
}

// ---- editor ----------------------------------------------------------------------------------------------------
const PHRASES = [
  ['Tap "Files"', "tap the control named Files"],
  ['Tap the 2nd "Folder"', "tap the second control with that name"],
  ['Type "QA-T1" into "Name"', "type into a field (add: and press return)"],
  ["Scroll down 2 times", "down, up, left or right"],
  ["Go back · Wait 2 seconds · Press return · Hide the keyboard", ""],
  ['Long press "Report" · Drag "A" to "B"', ""],
  ["Open the app · Restart the app · Open the app fresh", ""],
  ["Check the folder QA-T1 is in the list", "takes a screenshot and shows this sentence next to it (also: Verify, Expect, Make sure)"],
];

async function editorView(ctx, slug, testSlug) {
  const [project, test0, builds, status, runs0] = await Promise.all([
    api("GET", `/api/projects/${slug}`), api("GET", `/api/projects/${slug}/tests/${testSlug}`), api("GET", `/api/projects/${slug}/builds`),
    api("GET", "/api/status"), api("GET", `/api/projects/${slug}/runs/${testSlug}`)]);
  let saved = test0;
  const linesText = (t) => t.lines.map((l) => l.text).join("\n");
  const name = h("input", { type: "text", id: "test-title", value: saved.name, "aria-label": "Test name" });
  const start = h("select", { id: "test-start", "aria-label": "Start" }, Object.entries({ fresh: "Fresh install", relaunch: "Restart the app", "as-is": "Leave as it is" }).map(([v, label]) => h("option", { value: v, selected: v === saved.start }, label)));
  start.value = saved.start;
  const startHelp = h("span", { class: "hint" }, START_HELP[saved.start]);
  const text = h("textarea", { id: "test-lines", rows: 12, spellcheck: "false", placeholder: 'Tap "Files"\nmake a new folder called QA-T1\nCheck the folder QA-T1 is in the list' });
  text.value = linesText(saved);
  const msg = h("div");
  const mapped = h("div", { class: "card mapped", id: "mapped" });
  const mappedNote = h("div", { class: "hint", style: "margin-bottom:6px" });
  const save = h("button", { type: "button", id: "save" }, "Save");
  const run = h("button", { class: "primary", type: "button", id: "run" }, "Run");

  const dirty = () => text.value !== linesText(saved) || name.value !== saved.name || start.value !== saved.start;
  const drawMapped = () => {
    mappedNote.textContent = dirty() ? "Showing the last saved mapping. Save to update it." : "How each line will run";
    save.disabled = !dirty();
    run.textContent = dirty() ? "Save and run" : "Run";
    mapped.replaceChildren(...(saved.lines.length ? saved.lines.map((l) => h("div", { class: "line" },
      l.step
        ? [h("div", { class: "step" }, describeStep(l.step)),
           h("div", { class: "meta" }, howBadge(l), l.expected ? h("span", { class: "hint" }, `Expected: ${l.expected}`) : null),
           l.warning ? h("div", { class: "hint" }, l.warning) : null,
           l.how === "goal-fallback" ? h("div", { class: "hint" }, "The AI will work this out on the screen. To make it an exact step, name the control in quotes, like ", h("code", {}, 'Tap "Files"'), ".") : null]
        : h("div", { class: "muted small" }, l.text.trim() ? "Note, not run" : "(blank)"))) : [h("div", { class: "line muted" }, "Nothing saved yet.")]));
  };
  const doSave = async () => {
    msg.replaceChildren();
    save.disabled = true;
    try {
      saved = await api("PUT", `/api/projects/${slug}/tests/${testSlug}`, { name: name.value, start: start.value, lines: text.value.split("\n") });
      drawMapped();
      msg.replaceChildren(h("p", { class: "notice good" }, "Saved."));
      return true;
    } catch (err) {
      msg.replaceChildren(fail(err));
      drawMapped();
      return false;
    }
  };
  save.onclick = doSave;
  run.onclick = async () => {
    run.disabled = true;
    try {
      if (dirty() && !(await doSave())) return;
      const { stamp } = await api("POST", `/api/projects/${slug}/tests/${testSlug}/run`);
      location.hash = `#/p/${slug}/t/${testSlug}/run/${stamp}`;
    } catch (err) { msg.replaceChildren(fail(err)); } finally { run.disabled = false; }
  };
  for (const el of [text, name, start]) el.addEventListener("input", () => { startHelp.textContent = START_HELP[start.value]; drawMapped(); });
  drawMapped();

  // The history is redrawn on its own, so deleting a run does not lose lines typed above and not saved yet.
  let runs = runs0;
  const runsBox = h("div");
  const drawRuns = () => fill(runsBox,
    h("div", { class: "steps-head" }, h("h2", {}, "Runs"),
      runs.length ? confirmButton("Delete all runs", "Delete all? Click again", async () => { await api("DELETE", `/api/projects/${slug}/runs/${testSlug}`); runs = await api("GET", `/api/projects/${slug}/runs/${testSlug}`); drawRuns(); }) : null),
    runs.length
      ? h("div", { class: "card" }, runs.map((r) => h("div", { class: "row" },
          h("div", { class: "grow" }, h("a", { class: "title", href: `#/p/${slug}/t/${testSlug}/run/${r.stamp}` }, when(r.startedAt || r.stamp)), h("div", { class: "muted small" }, `${r.stepCount} steps${r.build ? ` · build ${r.build.version} (${r.build.build})` : ""}`)),
          statusBadge(r.status), verdictBadge(r.verdict),
          confirmButton("Delete", "Delete? Click again", async () => { await api("DELETE", `/api/projects/${slug}/runs/${testSlug}/${r.stamp}`); runs = runs.filter((x) => x.stamp !== r.stamp); drawRuns(); }))))
      : h("p", { class: "muted" }, "No runs yet."));
  drawRuns();

  const selected = builds.builds.find((b) => b.id === builds.selected);
  mount(ctx, [["Projects", "#/"], [project.name, `#/p/${slug}`], [saved.name, `#/p/${slug}/t/${testSlug}`]],
    h("h1", {}, name),
    h("p", { class: "sub" }, selected ? `Runs install ${selected.name} ${selected.version} (${selected.build}) first.` : "No build is selected: runs use whatever copy of the app is already on the simulator."),
    status.typesafe ? null : h("p", { class: "notice" }, "TYPESAFE_API_KEY is not set, so lines that are not a fixed phrase are saved as goals and the AI decides on the screen. Fixed phrases still become exact steps."),
    h("div", { class: "panel", style: "margin-bottom:16px" }, h("div", { class: "inline form" }, h("label", { class: "field" }, "Start", start)), startHelp),
    h("div", { class: "editor" },
      h("div", {}, h("div", { class: "hint", style: "margin-bottom:6px" }, "One step per line. Start a line with # for a note."), text,
        h("details", { style: "margin-top:8px" }, h("summary", { class: "hint" }, "Phrases that run exactly"),
          h("ul", { class: "hint" }, PHRASES.map(([p, d]) => h("li", {}, h("code", {}, p), d ? ` — ${d}` : "")))),
        h("div", { style: "display:flex;gap:8px;margin-top:10px" }, save, run), msg),
      h("div", {}, mappedNote, mapped)),
    runsBox);
}

// ---- run: live view and review ---------------------------------------------------------------------------------
async function runView(ctx, slug, testSlug, stamp) {
  let run = await api("GET", `/api/projects/${slug}/runs/${testSlug}/${stamp}`);
  let phase = null;
  let current = null;
  const base = `/files/${slug}/runs/${testSlug}/${stamp}`;
  const body = h("div");
  const live = () => run.status === "running";

  const items = () => {
    const list = [{ n: 0, line: START_LABELS[run.test.start] ?? "Start", step: null }];
    let n = 0;
    run.test.lines.forEach((l, lineIndex) => { if (l.step) list.push({ n: ++n, line: l.text, step: l.step, expected: l.expected, lineIndex }); });
    return list;
  };

  // Edits change the saved test, never this run (it stays the record of what was run). `plan` is the test's lines as they
  // read now: every line of the run's copy (`orig` = its index there) plus lines added here; `gone` = deleted from the test.
  // Lines are matched by text on save, so a changed position never loses the mapping of the lines that did not change.
  const testUrl = `/api/projects/${slug}/tests/${testSlug}`;
  let plan = run.test.lines.map((line, orig) => ({ key: `o${orig}`, orig, text: line.text, line, gone: false }));
  let added = 0;
  let ui = { editing: null, adding: null, error: null };
  let changed = false;
  const setUi = (patch) => { ui = { editing: null, adding: null, error: null, ...patch }; draw(); };
  const commit = async (build, key) => {
    try {
      const current = await api("GET", testUrl);
      const known = plan.filter((e) => !e.gone).map((e) => e.text);
      if (current.lines.length !== known.length || current.lines.some((l, i) => l.text !== known[i])) throw new Error("The test was changed after this run, so the steps here no longer match it. Open the test to edit it.");
      const next = build(plan.map((e) => ({ ...e })));
      const saved = await api("PUT", testUrl, { name: current.name, start: current.start, lines: next.filter((e) => !e.gone).map((e) => e.text) });
      let k = 0;
      for (const e of next) if (!e.gone) { e.line = saved.lines[k++]; e.text = e.line.text; }
      plan = next;
      changed = true;
      setUi({});
    } catch (err) { ui = { ...ui, error: { key, message: err.message } }; draw(); }
  };
  const needText = (key, text) => { if (text.trim()) return true; ui = { ...ui, error: { key, message: "Write the step first." } }; draw(); return false; };
  const editLine = (key, text) => needText(key, text) && commit((p) => (p.find((e) => e.key === key).text = text, p), key);
  const removeLine = (key) => commit((p) => p.flatMap((e) => (e.key !== key ? [e] : e.orig == null ? [] : [{ ...e, gone: true }])), key);
  const addLine = (after, text) => needText(after, text) && commit((p) => {
    p.splice(after === "start" ? 0 : p.findIndex((e) => e.key === after) + 1, 0, { key: `n${added++}`, orig: null, text, line: null, gone: false });
    return p;
  }, after);
  const runAgain = async (button, out) => {
    button.disabled = true;
    try { const { stamp: next } = await api("POST", `/api/projects/${slug}/tests/${testSlug}/run`); location.hash = `#/p/${slug}/t/${testSlug}/run/${next}`; }
    catch (err) { out.replaceChildren(fail(err)); button.disabled = false; }
  };

  const lineEditor = (key, initial, label, onSave) => {
    const input = h("input", { type: "text", class: "step-input", "aria-label": label, value: initial, placeholder: 'Tap "Files"' });
    const save = () => onSave(input.value);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setUi({}); });
    queueMicrotask(() => input.focus());
    return h("div", { class: "step-edit" }, input,
      h("div", { class: "row-actions" }, h("button", { class: "primary", type: "button", onclick: save }, "Save"), h("button", { type: "button", onclick: () => setUi({}) }, "Cancel")),
      ui.error?.key === key ? h("p", { class: "notice bad" }, ui.error.message) : null);
  };

  const mapped = (line) => line.step
    ? h("div", { class: "meta" }, h("span", { class: "muted small mono" }, describeStep(line.step)), " ", howBadge(line))
    : h("div", { class: "muted small" }, line.text.trim() ? "Note, not run" : "(blank)");

  const editedNote = (it, e) => e && !e.gone && e.text !== it.line
    ? h("div", { class: "edited" }, h("div", { class: "hint" }, "The test now says (this run is unchanged):"), h("div", { class: "line-text" }, e.line.text), mapped(e.line))
    : null;

  const controls = (e) => !live() && !e.gone
    ? [h("button", { class: "link edit-step", type: "button", onclick: () => setUi({ editing: e.key }) }, "Edit step"),
       h("button", { class: "link edit-step danger", type: "button", onclick: () => removeLine(e.key) }, "Delete step")]
    : null;

  const addRow = (key) => live() ? null
    : ui.adding === key
      ? h("div", { class: "add-row" }, lineEditor(key, "", "New step", (text) => addLine(key, text)))
      : h("div", { class: "add-row" }, h("button", { class: "link", type: "button", onclick: () => setUi({ adding: key }) }, "+ Add a step here"), ui.error?.key === key ? h("p", { class: "notice bad" }, ui.error.message) : null);

  const stepItem = (it, e) => {
    const rec = run.steps.find((s) => s.n === it.n);
    const state = rec ? (rec.ok ? "ok" : "fail") : live() && current === it.n ? "run" : "waiting";
    const notRun = !rec && !live();
    return h("div", { class: `card item ${state === "waiting" || e?.gone ? "waiting" : ""}`, "data-step": it.n },
      h("div", { class: `dot ${state}` }, state === "ok" ? "✓" : state === "fail" ? "✗" : state === "run" ? "…" : it.n),
      h("div", {},
        e && ui.editing === e.key
          ? lineEditor(e.key, e.text, `Step ${it.n}`, (text) => editLine(e.key, text))
          : [h("div", { class: "line-text" }, it.line, e ? controls(e) : null, e?.gone ? badge("Deleted from the test", "warn") : null),
             e && ui.error?.key === e.key ? h("p", { class: "notice bad" }, ui.error.message) : null,
             editedNote(it, e)],
        h("div", { class: "muted small mono" }, it.step ? describeStep(it.step) : rec?.step ? describeStep(rec.step) : ""),
        it.expected ? h("div", { class: "expected" }, h("strong", {}, "Expected: "), it.expected) : null,
        rec ? [rec.summary ? h("pre", {}, rec.summary) : null, rec.screen ? h("pre", {}, rec.screen) : null] : null,
        notRun ? h("div", { class: "muted small" }, "Not run") : null),
      h("div", { class: "shot" }, rec?.shot ? h("img", { src: `${base}/${rec.shot}`, alt: `Screen after step ${it.n}`, loading: "lazy", onclick: () => lightbox(`${base}/${rec.shot}`) }) : null));
  };

  // A step added on this screen: it has no record yet because it has not run.
  const newItem = (e) => h("div", { class: "card item waiting new-step" },
    h("div", { class: "dot waiting" }, "+"),
    h("div", {},
      ui.editing === e.key
        ? lineEditor(e.key, e.text, "New step", (text) => editLine(e.key, text))
        : [h("div", { class: "line-text" }, e.text, controls(e)), ui.error?.key === e.key ? h("p", { class: "notice bad" }, ui.error.message) : null, mapped(e.line), h("div", { class: "muted small" }, "New step: not run yet")]),
    h("div"));

  const installItem = () => {
    if (!run.build) return null;
    const i = run.install;
    const state = i ? (i.ok ? "ok" : "fail") : live() && phase === "installing" ? "run" : "waiting";
    return h("div", { class: `card item ${state === "waiting" ? "waiting" : ""}`, id: "install-step" },
      h("div", { class: `dot ${state}` }, state === "ok" ? "✓" : state === "fail" ? "✗" : state === "run" ? "…" : "·"),
      h("div", {}, h("div", { class: "line-text" }, `Install build ${run.build.version} (${run.build.build})`),
        i ? h("div", { class: "muted small" }, i.ok ? `Installed on ${i.udid} in ${seconds(i.ms)}` : `Failed: ${i.error}`) : null),
      h("div"));
  };

  const verdictPanel = () => {
    const note = h("textarea", { rows: 3, id: "verdict-note", placeholder: "What you saw (optional)", style: "font-family:inherit" });
    note.value = run.verdict?.note ?? "";
    const pick = (value) => h("label", {}, h("input", { type: "radio", name: "verdict", value, checked: run.verdict?.result === value }), h("span", {}, value === "pass" ? "Pass" : "Fail"));
    const out = h("div");
    return h("div", { class: "panel verdict", id: "verdict" },
      h("div", { class: "choices" }, pick("pass"), pick("fail")), note,
      h("div", {}, h("button", { class: "primary", type: "button", id: "save-verdict", onclick: async () => {
        const result = document.querySelector("input[name=verdict]:checked")?.value;
        if (!result) return out.replaceChildren(h("p", { class: "notice" }, "Choose Pass or Fail."));
        try { run = await api("PUT", `/api/projects/${slug}/runs/${testSlug}/${stamp}/verdict`, { result, note: note.value }); draw(); } catch (err) { out.replaceChildren(fail(err)); }
      } }, "Save verdict")), out,
      run.verdict ? h("div", { class: "hint" }, `Saved ${when(run.verdict.at)}`) : null);
  };

  const draw = () => {
    const duration = run.endedAt ? seconds(new Date(run.endedAt) - new Date(run.startedAt)) : null;
    const phaseText = { leasing: "Leasing a simulator…", installing: "Installing the build…", starting: "Starting the app…" }[phase];
    fill(body,
      h("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, h("h1", { style: "margin:0" }, run.test.name), statusBadge(run.status), verdictBadge(run.verdict)),
      h("p", { class: "sub" }, `${when(run.startedAt)}${duration ? ` · ${duration}` : ""}`),
      live() && phaseText ? h("p", { class: "notice" }, phaseText) : null,
      run.status === "failed" ? h("p", { class: "notice bad", id: "run-reason" }, run.failedAt === "install" ? `The build could not be installed: ${run.reason}` : `Stopped at step ${run.failedAt}: ${run.reason}`) : null,
      run.status === "inconclusive" ? h("p", { class: "notice", id: "run-reason" }, `Inconclusive: ${run.reason}`) : null,
      run.status === "error" ? h("p", { class: "notice bad", id: "run-reason" }, `Studio could not finish this run: ${run.reason}`) : null,
      (run.warnings ?? []).map((w) => h("p", { class: "notice" }, w)),
      h("dl", { class: "kv" }, h("dt", {}, "App"), h("dd", {}, run.app),
        h("dt", {}, "Build"), h("dd", {}, run.build ? `${run.build.version} (${run.build.build}) · ${run.build.bundleId}` : "none installed by Studio: used the copy on the simulator"),
        h("dt", {}, "Start"), h("dd", {}, run.test.start)),
      h("div", { class: "steps-head" }, h("h2", {}, "Steps"), changed && !live() ? (() => { const out = h("span"); const b = h("button", { class: "primary", type: "button", id: "run-again" }, "Run the test again"); b.onclick = () => runAgain(b, out); return h("span", {}, b, out); })() : null),
      h("div", { class: "timeline" }, installItem(), items().slice(0, 1).map((it) => stepItem(it)), addRow("start"),
        (() => { const byLine = new Map(items().filter((it) => it.lineIndex != null).map((it) => [it.lineIndex, it]));
          return plan.flatMap((e) => { const card = e.orig == null ? newItem(e) : byLine.has(e.orig) ? stepItem(byLine.get(e.orig), e) : null; return card ? [card, addRow(e.key)] : []; }); })()),
      run.video ? [h("h2", {}, "Video"), h("video", { controls: true, preload: "metadata", src: `${base}/${run.video}`, id: "run-video" }), run.sheet ? h("p", {}, h("a", { href: `${base}/${run.sheet}`, target: "_blank" }, "Contact sheet")) : null] : null,
      run.status === "completed" || run.status === "failed" ? [h("h2", {}, "Your verdict"), verdictPanel()] : null,
      live() ? null : h("div", { class: "delete-run" }, confirmButton("Delete this run", "Delete this run? Click again", async () => { await api("DELETE", `/api/projects/${slug}/runs/${testSlug}/${stamp}`); location.hash = `#/p/${slug}/t/${testSlug}`; })));
  };

  if (!mount(ctx, [["Projects", "#/"], [slug, `#/p/${slug}`], [run.test.name, `#/p/${slug}/t/${testSlug}`], [when(run.startedAt), `#/p/${slug}/t/${testSlug}/run/${stamp}`]], body)) return;
  draw();

  const refetch = async () => { run = await api("GET", `/api/projects/${slug}/runs/${testSlug}/${stamp}`); draw(); };
  if (live()) {
    const source = new EventSource(`/api/runs/${enc(`${slug}.${testSlug}.${stamp}`)}/events`);
    ctx.onLeave(() => source.close());
    source.onmessage = async (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === "phase") phase = e.phase;
      if (e.type === "step-start") { phase = null; current = e.n; }
      if (e.type === "step-end") { const { type, ...rec } = e; run.steps = [...run.steps.filter((s) => s.n !== rec.n), rec]; }
      if (e.type === "run-end") { source.close(); return refetch(); }
      draw();
    };
    // The page was opened after the run ended, or Studio restarted: fall back to reading the run.
    source.onerror = () => { source.close(); const poll = setInterval(async () => { if (ctx.dead) return clearInterval(poll); await refetch().catch(() => {}); if (!live()) clearInterval(poll); }, 2000); ctx.onLeave(() => clearInterval(poll)); };
  }
}

// ---- router ------------------------------------------------------------------------------------------------------
const routes = [
  [/^#\/p\/([^/]+)\/t\/([^/]+)\/run\/([^/]+)$/, runView],
  [/^#\/p\/([^/]+)\/t\/([^/]+)$/, editorView],
  [/^#\/p\/([^/]+)$/, projectView],
  [/^#\/?$/, projectsView],
];
let ctx = null;
async function render() {
  ctx?.leave();
  const mine = (ctx = { dead: false, leavers: [], onLeave(fn) { this.leavers.push(fn); }, leave() { this.dead = true; this.leavers.forEach((fn) => fn()); } });
  const hash = location.hash || "#/";
  for (const [re, view] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    try { await view(mine, ...m.slice(1).map(decodeURIComponent)); } catch (err) { mount(mine, [["Projects", "#/"]], h("h1", {}, "Something went wrong"), fail(err)); }
    return;
  }
  mount(mine, [["Projects", "#/"]], h("h1", {}, "Not found"), h("p", {}, h("a", { href: "#/" }, "Back to projects")));
}
window.addEventListener("hashchange", render);
render();
