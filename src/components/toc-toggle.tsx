"use client";

import { useEffect, useRef } from "react";

/**
 * Progressive enhancement for the engine-rendered TOC: injects a mono
 * [hide]/[show] toggle into `.wiki-toc > .toctitle` of the sibling
 * `.wiki-prose` block (theme.md §Article surface). No-op when the page
 * has no TOC.
 */
export function TocToggle() {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const host = ref.current?.previousElementSibling;
    if (!host) return;
    const toc = host.querySelector<HTMLElement>(".wiki-toc");
    const title = toc?.querySelector<HTMLElement>(".toctitle");
    if (!toc || !title || title.querySelector(".toctoggle")) return;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "toctoggle";

    const setLabel = (hidden: boolean) => {
      button.textContent = hidden ? "[show]" : "[hide]";
      button.setAttribute("aria-expanded", String(!hidden));
    };
    setLabel(false);

    const onClick = () => {
      setLabel(toc.classList.toggle("toc-hidden"));
    };
    button.addEventListener("click", onClick);
    title.appendChild(button);

    return () => {
      button.removeEventListener("click", onClick);
      button.remove();
      toc.classList.remove("toc-hidden");
    };
  }, []);

  return <span hidden ref={ref} />;
}
