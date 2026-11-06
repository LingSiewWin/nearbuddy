"use client";
// Human / Agent view. Both forms of every panel are in the HTML (an agent reading the page without JS sees
// the endpoints too); <html data-view="agent"> shows the machine form. The choice lives in the URL hash
// (#agent, shareable) and is remembered per browser.
import { useSyncExternalStore } from "react";

export type View = "human" | "agent";
const read = (): View =>
  typeof document !== "undefined" && document.documentElement.dataset.view === "agent" ? "agent" : "human";
const subscribe = (cb: () => void) => {
  window.addEventListener("nb-view", cb);
  return () => window.removeEventListener("nb-view", cb);
};
export const useView = () => useSyncExternalStore(subscribe, read, () => "human" as View);

export function setView(v: View) {
  document.documentElement.dataset.view = v;
  try {
    localStorage.setItem("nb-view", v);
  } catch {}
  history.replaceState(null, "", v === "agent" ? "#agent" : location.pathname + location.search);
  window.dispatchEvent(new Event("nb-view"));
}

/** Runs before paint (inlined in the layout) so a #agent link never flashes the human view. */
export const VIEW_BOOT = `try{var v=location.hash==="#agent"?"agent":location.hash?null:localStorage.getItem("nb-view");if(v==="agent")document.documentElement.dataset.view="agent"}catch(e){}`;

export function ViewToggle() {
  const v = useView();
  return (
    <fieldset className="view">
      <legend className="sr">Who is reading</legend>
      <button type="button" aria-pressed={v === "human"} onClick={() => setView("human")}>
        Human
      </button>
      <button type="button" aria-pressed={v === "agent"} onClick={() => setView("agent")}>
        Agent
      </button>
    </fieldset>
  );
}
