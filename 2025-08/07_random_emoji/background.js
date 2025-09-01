// Build comprehensive emoji list from ranges
function buildEmojiList() {
  const emojis = [];
  
  // Define ranges with actual emoji density
  const emojiRanges = [
    // Emoticons (all valid)
    { start: 0x1F600, end: 0x1F64F },
    // Hand gestures  
    { start: 0x1F44D, end: 0x1F44F },
    { start: 0x1F645, end: 0x1F64F },
    { start: 0x1F680, end: 0x1F6C5 },
    // Misc symbols and pictographs (carefully selected ranges)
    { start: 0x1F300, end: 0x1F321 },
    { start: 0x1F324, end: 0x1F393 },
    { start: 0x1F396, end: 0x1F397 },
    { start: 0x1F399, end: 0x1F39B },
    { start: 0x1F39E, end: 0x1F3F0 },
    { start: 0x1F3F3, end: 0x1F3F5 },
    { start: 0x1F3F7, end: 0x1F3FA },
    { start: 0x1F400, end: 0x1F43E },
    { start: 0x1F440, end: 0x1F4FD },
    { start: 0x1F4FF, end: 0x1F53D },
    { start: 0x1F54B, end: 0x1F54E },
    { start: 0x1F550, end: 0x1F567 },
    { start: 0x1F56F, end: 0x1F570 },
    { start: 0x1F573, end: 0x1F579 },
    { start: 0x1F587, end: 0x1F587 },
    { start: 0x1F58A, end: 0x1F58D },
    { start: 0x1F590, end: 0x1F590 },
    { start: 0x1F595, end: 0x1F596 },
    { start: 0x1F5A4, end: 0x1F5A5 },
    { start: 0x1F5A8, end: 0x1F5A8 },
    { start: 0x1F5B1, end: 0x1F5B2 },
    { start: 0x1F5BC, end: 0x1F5BC },
    { start: 0x1F5C2, end: 0x1F5C4 },
    { start: 0x1F5D1, end: 0x1F5D3 },
    { start: 0x1F5DC, end: 0x1F5DE },
    { start: 0x1F5E1, end: 0x1F5E1 },
    { start: 0x1F5E3, end: 0x1F5E3 },
    { start: 0x1F5E8, end: 0x1F5E8 },
    { start: 0x1F5EF, end: 0x1F5EF },
    { start: 0x1F5F3, end: 0x1F5F3 },
    { start: 0x1F5FA, end: 0x1F64F },
    { start: 0x1F680, end: 0x1F6C5 },
    { start: 0x1F6CB, end: 0x1F6D2 },
    { start: 0x1F6D5, end: 0x1F6D7 },
    { start: 0x1F6E0, end: 0x1F6E5 },
    { start: 0x1F6E9, end: 0x1F6E9 },
    { start: 0x1F6EB, end: 0x1F6EC },
    { start: 0x1F6F0, end: 0x1F6F0 },
    { start: 0x1F6F3, end: 0x1F6FC },
    // Supplemental symbols
    { start: 0x1F7E0, end: 0x1F7EB },
    { start: 0x1F90C, end: 0x1F93A },
    { start: 0x1F93C, end: 0x1F945 },
    { start: 0x1F947, end: 0x1F94C },
    { start: 0x1F94D, end: 0x1F94F },
    { start: 0x1F950, end: 0x1F96B },
    { start: 0x1F96C, end: 0x1F970 },
    { start: 0x1F973, end: 0x1F976 },
    { start: 0x1F97A, end: 0x1F97A },
    { start: 0x1F97C, end: 0x1F9A2 },
    { start: 0x1F9A3, end: 0x1F9A4 },
    { start: 0x1F9A5, end: 0x1F9AA },
    { start: 0x1F9AE, end: 0x1F9CA },
    { start: 0x1F9CB, end: 0x1F9CD },
    { start: 0x1F9D0, end: 0x1F9E6 },
    { start: 0x1F9E7, end: 0x1F9FF },
    { start: 0x1FA70, end: 0x1FA73 },
    { start: 0x1FA78, end: 0x1FA7A },
    { start: 0x1FA80, end: 0x1FA82 },
    { start: 0x1FA90, end: 0x1FA95 },
    { start: 0x1FAA0, end: 0x1FAA8 },
    { start: 0x1FAB0, end: 0x1FAB6 },
    { start: 0x1FAC0, end: 0x1FAC2 },
    { start: 0x1FAD0, end: 0x1FAD6 },
    // Some misc symbols that are emojis
    { start: 0x231A, end: 0x231B },
    { start: 0x2328, end: 0x2328 },
    { start: 0x23CF, end: 0x23CF },
    { start: 0x23E9, end: 0x23F3 },
    { start: 0x23F8, end: 0x23FA },
    { start: 0x24C2, end: 0x24C2 },
    { start: 0x25AA, end: 0x25AB },
    { start: 0x25B6, end: 0x25B6 },
    { start: 0x25C0, end: 0x25C0 },
    { start: 0x25FB, end: 0x25FE },
    { start: 0x2600, end: 0x2604 },
    { start: 0x260E, end: 0x260E },
    { start: 0x2611, end: 0x2611 },
    { start: 0x2614, end: 0x2615 },
    { start: 0x2618, end: 0x2618 },
    { start: 0x261D, end: 0x261D },
    { start: 0x2620, end: 0x2620 },
    { start: 0x2622, end: 0x2623 },
    { start: 0x2626, end: 0x2626 },
    { start: 0x262A, end: 0x262A },
    { start: 0x262E, end: 0x262F },
    { start: 0x2638, end: 0x263A },
    { start: 0x2640, end: 0x2640 },
    { start: 0x2642, end: 0x2642 },
    { start: 0x2648, end: 0x2653 },
    { start: 0x265F, end: 0x2660 },
    { start: 0x2663, end: 0x2663 },
    { start: 0x2665, end: 0x2666 },
    { start: 0x2668, end: 0x2668 },
    { start: 0x267B, end: 0x267B },
    { start: 0x267E, end: 0x267F },
    { start: 0x2692, end: 0x2697 },
    { start: 0x2699, end: 0x2699 },
    { start: 0x269B, end: 0x269C },
    { start: 0x26A0, end: 0x26A1 },
    { start: 0x26A7, end: 0x26A7 },
    { start: 0x26AA, end: 0x26AB },
    { start: 0x26B0, end: 0x26B1 },
    { start: 0x26BD, end: 0x26BE },
    { start: 0x26C4, end: 0x26C5 },
    { start: 0x26C8, end: 0x26C8 },
    { start: 0x26CE, end: 0x26CF },
    { start: 0x26D1, end: 0x26D1 },
    { start: 0x26D3, end: 0x26D4 },
    { start: 0x26E9, end: 0x26EA },
    { start: 0x26F0, end: 0x26F5 },
    { start: 0x26F7, end: 0x26FA },
    { start: 0x26FD, end: 0x26FD },
    { start: 0x2702, end: 0x2702 },
    { start: 0x2705, end: 0x2705 },
    { start: 0x2708, end: 0x270D },
    { start: 0x270F, end: 0x270F },
    { start: 0x2712, end: 0x2712 },
    { start: 0x2714, end: 0x2714 },
    { start: 0x2716, end: 0x2716 },
    { start: 0x271D, end: 0x271D },
    { start: 0x2721, end: 0x2721 },
    { start: 0x2728, end: 0x2728 },
    { start: 0x2733, end: 0x2734 },
    { start: 0x2744, end: 0x2744 },
    { start: 0x2747, end: 0x2747 },
    { start: 0x274C, end: 0x274C },
    { start: 0x274E, end: 0x274E },
    { start: 0x2753, end: 0x2755 },
    { start: 0x2757, end: 0x2757 },
    { start: 0x2763, end: 0x2764 },
    { start: 0x2795, end: 0x2797 },
    { start: 0x27A1, end: 0x27A1 },
    { start: 0x27B0, end: 0x27B0 },
    { start: 0x27BF, end: 0x27BF },
    { start: 0x2934, end: 0x2935 },
    { start: 0x2B05, end: 0x2B07 },
    { start: 0x2B1B, end: 0x2B1C },
    { start: 0x2B50, end: 0x2B50 },
    { start: 0x2B55, end: 0x2B55 },
    { start: 0x3030, end: 0x3030 },
    { start: 0x303D, end: 0x303D },
    { start: 0x3297, end: 0x3297 },
    { start: 0x3299, end: 0x3299 },
  ];
  
  // Build the emoji list
  for (const range of emojiRanges) {
    for (let code = range.start; code <= range.end; code++) {
      const char = String.fromCodePoint(code);
      // Basic check to see if it renders as emoji (not foolproof but helps)
      if (char.length > 0 && !char.match(/[\u0000-\u001F\u007F-\u009F]/)) {
        emojis.push(code);
      }
    }
  }
  
  return emojis;
}

// Initialize emoji list
const validEmojis = buildEmojiList();
console.log(`Loaded ${validEmojis.length} emojis`);

// Generate truly random emoji
function getRandomEmoji() {
  const randomIndex = Math.floor(Math.random() * validEmojis.length);
  return String.fromCodePoint(validEmojis[randomIndex]);
}

// Create context menu when extension starts
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'insertRandomEmoji',
    title: 'Insert random emoji 🎲',
    contexts: ['editable']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'insertRandomEmoji') {
    // Get truly random emoji from Unicode
    const randomEmoji = getRandomEmoji();
    
    // Insert emoji at cursor position
    chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: insertEmojiAtCursor,
      args: [randomEmoji]
    });
  }
});

// Function to inject into the page to insert emoji at cursor
function insertEmojiAtCursor(emoji) {
  const activeElement = document.activeElement;
  
  if (activeElement && (
    activeElement.tagName === 'INPUT' || 
    activeElement.tagName === 'TEXTAREA' || 
    activeElement.contentEditable === 'true'
  )) {
    
    // For regular input/textarea elements
    if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') {
      const start = activeElement.selectionStart;
      const end = activeElement.selectionEnd;
      const text = activeElement.value;
      
      activeElement.value = text.slice(0, start) + emoji + text.slice(end);
      activeElement.selectionStart = activeElement.selectionEnd = start + emoji.length;
      
      // Trigger input event for frameworks like React
      activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // For contentEditable elements
    else if (activeElement.contentEditable === 'true') {
      const selection = window.getSelection();
      const range = selection.getRangeAt(0);
      
      range.deleteContents();
      const textNode = document.createTextNode(emoji);
      range.insertNode(textNode);
      
      // Move cursor after the emoji
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Trigger input event
      activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    }
    
    // Focus back on the element
    activeElement.focus();
  }
}
