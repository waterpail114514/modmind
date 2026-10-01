/** Native child views sit outside DOM stacking; suspend them while a host modal is visible. */
export function hostModalVisible(): boolean {
  return [...document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open], .modal-backdrop')]
    .some(element => element.getClientRects().length > 0 && !element.closest('[hidden], [aria-hidden="true"]') && getComputedStyle(element).visibility !== 'hidden')
}

export function observeHostModals(changed: () => void): () => void {
  let visible = hostModalVisible()
  const observer = new MutationObserver(() => {
    const next = hostModalVisible()
    if (next !== visible) { visible = next; changed() }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'open', 'aria-hidden', 'aria-modal', 'class', 'style'] })
  return () => observer.disconnect()
}
