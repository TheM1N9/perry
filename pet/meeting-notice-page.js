let current = null;
const panel = document.querySelector("main");
const $ = (selector) => document.querySelector(selector);
const send = (name) => current && window.meetingNotice.action(name, current.id);
const off = window.meetingNotice.onState((state) => {
  current = state;
  panel.hidden = !state;
  if (!state) return;
  $("h1").textContent = state.title;
  $("h1").title = state.title;
  $("#detail").textContent = state.detail;
  $("#detail").title = state.detail;
  $("#start-label").textContent = state.primary?.label ?? "";
  $("#start").disabled = state.primary?.disabled === true;
  // The waveform belongs to starting the notetaker, not to Stop, Keep going or View notes.
  $("#start svg").style.display = state.primary?.name === "start" ? "" : "none";
  $("#second").hidden = !state.secondary;
  $("#second").textContent = state.secondary?.label ?? "";
  $("#menu").hidden = !state.menu;
  $("#close").hidden = !state.closable;
  panel.dataset.recording = String(Boolean(state.recording));
  panel.dataset.warning = String(Boolean(state.warning));
});
$("#start").onclick = () => current?.primary && send(current.primary.name);
$("#second").onclick = () => current?.secondary && send(current.secondary.name);
$("#menu").onclick = () => send("menu");
$("#close").onclick = () => send("dismiss");
// Resting the pointer on the card pauses whatever it is counting down.
panel.addEventListener("mouseenter", () => send("hover"));
panel.addEventListener("mouseleave", () => send("leave"));
document.onkeydown = (event) => { if (event.key === "Escape" && current?.closable) send("dismiss"); };
window.addEventListener("pagehide", off, { once: true });
