import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs";

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const APP_ROOT = "/home/pyodide/app";
let pyodide = null;
let readyPromise = null;
const loadedPaths = new Set();

function send(id, ok, data = null, error = null) { self.postMessage({ id, ok, data, error }); }
function ensureDir(path) { try { pyodide.FS.mkdirTree(path); } catch (_) {} }

async function fetchWrite(relPath, binary = true) {
  if (loadedPaths.has(relPath)) return;
  const response = await fetch(new URL(relPath, self.location.href));
  if (!response.ok) throw new Error(`파일 로드 실패: ${relPath} (${response.status})`);
  const fullPath = `${APP_ROOT}/${relPath}`;
  const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
  ensureDir(parent);
  if (binary) {
    const data = new Uint8Array(await response.arrayBuffer());
    pyodide.FS.writeFile(fullPath, data);
  } else {
    pyodide.FS.writeFile(fullPath, await response.text(), { encoding: "utf8" });
  }
  loadedPaths.add(relPath);
}

async function ensureReady() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
    await pyodide.loadPackage("Pillow");
    ensureDir(APP_ROOT);
    ensureDir("/tmp");
    await fetchWrite("render_helpers.py", false);
    await fetchWrite("render_card.py", false);
    await fetchWrite("engine.py", false);
    await pyodide.runPythonAsync(`
import sys, json, io, base64
sys.path.insert(0, ${JSON.stringify(APP_ROOT)})
import engine
PHOTO_PATH = "/tmp/tsuki_subject"

def render_card_web(template_json, params_json, out_w, out_h):
    template = json.loads(template_json)
    params = json.loads(params_json)
    extra = params.get("extra", {})
    image = engine.render_card(
        PHOTO_PATH,
        params.get("name", ""),
        template,
        element_color=params.get("element_color", "#FFFFFF"),
        text_color=params.get("text_color", "#FFFFFF"),
        focus_x=float(params.get("focus_x", 0.5)),
        focus_y=float(params.get("focus_y", 0.5)),
        zoom=float(params.get("zoom", 1.0)),
        font_override=params.get("font_override"),
        out_size=(int(out_w), int(out_h)),
        extra=extra,
    )
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")
`);
  })();
  return readyPromise;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};
  try {
    await ensureReady();
    if (type === "init") { send(id, true, { message: "ready" }); return; }
    if (type === "ensureAssets") {
      for (const relPath of payload.paths || []) await fetchWrite(relPath, true);
      send(id, true, { count: (payload.paths || []).length }); return;
    }
    if (type === "setPhoto") {
      const bytes = new Uint8Array(payload.buffer);
      pyodide.FS.writeFile("/tmp/tsuki_subject", bytes);
      send(id, true, { size: bytes.byteLength }); return;
    }
    if (type === "render") {
      const { template, params, width, height } = payload;
      pyodide.globals.set("_tpl_json", JSON.stringify(template));
      pyodide.globals.set("_params_json", JSON.stringify(params));
      pyodide.globals.set("_out_w", width);
      pyodide.globals.set("_out_h", height);
      const b64 = pyodide.runPython("render_card_web(_tpl_json, _params_json, _out_w, _out_h)");
      send(id, true, { base64: b64 }); return;
    }
    throw new Error(`알 수 없는 작업: ${type}`);
  } catch (error) {
    send(id, false, null, error?.stack || error?.message || String(error));
  }
};