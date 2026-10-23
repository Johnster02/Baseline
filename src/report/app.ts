/** The report page's own script: theme, run switcher, filters, copy, screenshot viewer. No data fetching. */
export const APP_JS = `(() => {
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
function sweep(){ const s = $("#sweep"); if (!s) return; s.classList.remove("go"); void s.offsetWidth; s.classList.add("go"); }
function setSkin(k, fx){ const h = document.documentElement; h.classList.remove("plain","light","dark");
  if (k !== "br2049") h.classList.add("plain", k);
  $$("[data-skin]").forEach(b => b.setAttribute("aria-pressed", b.dataset.skin === k));
  try { localStorage.setItem("baseline-skin", k); } catch (e) {}
  if (fx && k === "br2049") sweep(); }
$$("[data-skin]").forEach(b => b.onclick = () => setSkin(b.dataset.skin, true));
let saved = document.documentElement.dataset.theme || "br2049";
try { saved = localStorage.getItem("baseline-skin") || saved; } catch (e) {}
setSkin(["br2049","light","dark"].includes(saved) ? saved : "br2049", false);

function wipe(el, swap){ if (still || !el) { swap(); return; }
  el.classList.add("wipe-out"); setTimeout(() => { swap(); el.classList.remove("wipe-out"); el.classList.add("wipe-in");
    setTimeout(() => el.classList.remove("wipe-in"), 900); }, 420); }

$$("[data-pick]").forEach(b => b.onclick = () => {
  const id = b.dataset.pick, deck = $("#deck");
  wipe(deck, () => { $$(".run").forEach(r => r.hidden = r.dataset.run !== id);
    $$("[data-pick]").forEach(x => x.setAttribute("aria-current", x.dataset.pick === id)); });
});

$$(".run").forEach(run => {
  const st = { v: "all", p: null, q: "" };
  const list = $(".list", run);
  const apply = () => wipe(list, () => {
    let n = 0;
    $$(".f", list).forEach(f => {
      const ok = (st.v === "all" || f.dataset.group === st.v) && (!st.p || f.dataset.personas.split(",").includes(st.p))
        && (!st.q || f.dataset.text.includes(st.q));
      f.classList.toggle("gone", !ok); if (ok) f.style.setProperty("--i", n++);
    });
    const r = $(".readout b", run); if (r) r.textContent = n;
    $$(".tally i", run).forEach(i => i.classList.toggle("off", st.v !== "all" && i.dataset.group !== st.v));
  });
  $$("[data-filter]", run).forEach(b => b.onclick = () => { st.v = b.dataset.filter;
    $$("[data-filter]", run).forEach(x => x.setAttribute("aria-pressed", x.dataset.filter === st.v)); apply(); });
  $$("[data-persona]", run).forEach(b => b.onclick = () => { st.p = st.p === b.dataset.persona ? null : b.dataset.persona;
    $$("[data-persona]", run).forEach(x => x.setAttribute("aria-pressed", x.dataset.persona === st.p)); apply(); });
  $$("[data-passes]", run).forEach(b => b.onclick = () => { const p = $(".passes", run); if (!p) return;
    p.open = true; p.scrollIntoView({ behavior: "smooth", block: "start" }); });
  $$("[data-goto]", run).forEach(b => b.onclick = () => {
    const f = $$(".f", run).find(x => x.dataset.fid === b.dataset.goto); if (!f) return;
    const fold = f.closest(".passes"); if (fold) fold.open = true;
    if (f.classList.contains("gone")) { st.v = "all"; st.p = null; st.q = ""; const s = $(".search", run); if (s) s.value = "";
      $$("[data-filter]", run).forEach(x => x.setAttribute("aria-pressed", x.dataset.filter === "all"));
      $$("[data-persona]", run).forEach(x => x.setAttribute("aria-pressed", false)); apply(); }
    f.open = true; f.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  const q = $(".search", run); if (q) { let t; q.oninput = () => { clearTimeout(t); t = setTimeout(() => { st.q = q.value.trim().toLowerCase(); apply(); }, 180); }; }
});

$$("[data-copy]").forEach(b => b.onclick = async () => {
  try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = "Copied"; } catch (e) { b.textContent = "Copy failed"; }
  setTimeout(() => b.textContent = "Copy as issue", 1600);
});

const lb = $("#lb");
$$(".zoom").forEach(z => z.onclick = () => { $("img", lb).src = $("img", z).src; $(".p", lb).textContent = z.dataset.caption || "";
  lb.hidden = false; lb.classList.add("in"); $("button", lb).focus(); });
const close = () => { lb.hidden = true; lb.classList.remove("in"); };
if (lb) { $("button", lb).onclick = close; $(".lb-back", lb).onclick = close; addEventListener("keydown", e => { if (e.key === "Escape") close(); }); }
$$(".deck").forEach(d => d.classList.add("on"));
sweep();
})();`;
