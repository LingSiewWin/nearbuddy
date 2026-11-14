"use client";
// A block of text in the machine's voice with a button that copies it.
import { useState } from "react";

export function Copyable({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="copyable">
      <pre className="t-mono">{text}</pre>
      <button
        type="button"
        className="btn btn-quiet"
        aria-label={`Copy the ${label}`}
        onClick={() =>
          navigator.clipboard.writeText(text).then(
            () => setState("copied"),
            () => setState("failed"),
          )
        }
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select and copy by hand" : "Copy"}
      </button>
    </div>
  );
}
