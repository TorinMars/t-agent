// The keyboard shortcuts of the map editor, modelled on XMind (see "Mind maps" in DESIGN.md for the source of each key and those that are left out).
// `actionFor` says what a key press means while no text is being edited: an action name or null. It is pure so it can be tested without a page.
export function actionFor(event, apple) {
  const mod = apple ? event.metaKey : event.ctrlKey;
  if (apple ? event.ctrlKey : event.metaKey) return null; // Ctrl on a Mac and Windows-key combinations belong to the system
  const key = event.key || '';
  const letter = key.length === 1 ? key.toLowerCase() : key;
  if (mod) {
    if (event.altKey) return letter === 'a' ? 'selectChildren' : null;
    if (event.shiftKey) {
      switch (letter) {
        case 'z': return 'redo';
        case 'a': return 'selectSiblings';
        case 'k': return 'link';
        case 'n': return 'note';
        case 'l': return 'label';
        case '+': return 'zoomIn';
        default: return null;
      }
    }
    switch (key) {
      case 'Enter': return 'addParent';
      case 'Home': return 'goRoot';
      default: break;
    }
    switch (letter) {
      case 'z': return 'undo';
      case 'y': return 'redo';
      case 'a': return 'selectAll';
      case '=': case '+': return 'zoomIn';
      case '-': return 'zoomOut';
      case '0': return 'zoomReset';
      case '9': return 'fit';
      case '/': return 'toggleFold';
      case 'l': return 'relationship';
      case ']': return 'summary';
      case 's': return 'saveNow';
      default: return null;
    }
  }
  if (event.altKey) {
    if (key === 'ArrowUp') return 'moveUp';
    if (key === 'ArrowDown') return 'moveDown';
    return null;
  }
  if (event.shiftKey) {
    if (key === 'Enter') return 'addBefore';
    if (key === 'Tab') return 'goParent';
  }
  switch (key) {
    case 'Tab': return event.shiftKey ? 'goParent' : 'addChild';
    case 'Enter': return 'addSibling';
    case 'F2': return 'edit';
    case 'F3': return 'label';
    case 'F4': return 'note';
    case 'Delete': case 'Backspace': return 'remove';
    case 'ArrowUp': return 'up';
    case 'ArrowDown': return 'down';
    case 'ArrowLeft': return 'left';
    case 'ArrowRight': return 'right';
    case 'Home': return 'goRoot';
    case 'Escape': return 'back';
    case ' ': return event.shiftKey ? null : 'edit';
    default: break;
  }
  if (Array.from(key).length === 1 && !event.isComposing && event.keyCode !== 229) return 'type';
  return null;
}
