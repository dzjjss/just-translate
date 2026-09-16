import { waitForReply } from './action-feedback.js';

const DEADLINES = Object.freeze({
  'test-connection': 35000, 'list-models': 25000, 'convert-rules': 55000,
  'preflight-on-tab': 360000, 'lab-translate': 600000, 'preflight': 360000
});
export function runtimeReply(message) {
  return waitForReply(chrome.runtime.sendMessage(message), DEADLINES[message.type] || 15000);
}
export function tabReply(tabId, message) {
  return waitForReply(chrome.tabs.sendMessage(tabId, message));
}
