export function attachScrollbarAutoHide(el: HTMLElement, delayMs = 1200): () => void {
  el.classList.add("scrollbar-autohide");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onScroll = () => {
    el.setAttribute("data-scrolling", "true");
    clearTimeout(timer);
    timer = setTimeout(() => el.removeAttribute("data-scrolling"), delayMs);
  };
  el.addEventListener("scroll", onScroll, { passive: true });
  return () => {
    el.removeEventListener("scroll", onScroll);
    clearTimeout(timer);
    el.classList.remove("scrollbar-autohide");
    el.removeAttribute("data-scrolling");
  };
}
