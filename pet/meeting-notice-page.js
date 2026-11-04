let current = null;
const panel = document.querySelector("main");
const off = window.meetingNotice.onState((state) => {
  current = state;
  panel.hidden = !state;
  if (!state) return;
  document.querySelector("h1").textContent = state.title;
  document.querySelector("h1").title = state.title;
  document.querySelector("#detail").textContent = state.detail;
  document.querySelector("#detail").title = state.detail;
  document.querySelector("#start-label").textContent = state.recording ? "Finish" : "Start Notetaker";
  document.querySelector("#start").disabled = state.busy === true;
  panel.dataset.recording = String(Boolean(state.recording));
});
document.querySelector("#start").onclick = () => current && window.meetingNotice.action("start", current.id);
document.querySelector("#menu").onclick = () => current && window.meetingNotice.action("menu", current.id);
document.onkeydown = (event) => { if (event.key === "Escape" && current) window.meetingNotice.action("dismiss", current.id); };
window.addEventListener("pagehide", off, { once: true });
