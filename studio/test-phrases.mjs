import assert from "node:assert/strict";
import { isComment, parsePhrase } from "./phrases.mjs";

const step = (line) => parsePhrase(line)?.step;

// The most common line stays code-only: a TypeSafe call per tap would cost money and make runs drift.
assert.deepEqual(step('Tap "Files"'), { tool: "tap", label: "Files" });
assert.deepEqual(step("tap “Files”."), { tool: "tap", label: "Files" });
assert.deepEqual(step('Tap the 2nd "Folder"'), { tool: "tap", label: "Folder", nth: 2 });
assert.deepEqual(step('tap the second "Folder"'), { tool: "tap", label: "Folder", nth: 2 });
assert.deepEqual(step("Tap at 120, 340"), { tool: "tap_at", x: 120, y: 340 });

// Wrong args would type into the wrong field, scroll the wrong way or wait the wrong time.
assert.deepEqual(step('Type "QA-T1" into "Name"'), { tool: "type", text: "QA-T1", into: "Name" });
assert.deepEqual(step('Type "hello"'), { tool: "type", text: "hello" });
assert.deepEqual(step('type "cats" into "Search" and press return'), { tool: "type", text: "cats", into: "Search", submit: true });
assert.deepEqual(step('Type "cats" and press return'), { tool: "type", text: "cats", submit: true });
assert.deepEqual(step("Scroll down 2 times"), { tool: "scroll", direction: "down", times: 2 });
assert.deepEqual(step("scroll up"), { tool: "scroll", direction: "up" });
assert.equal(parsePhrase("Scroll down 40 times"), null, "more than the step allows goes to the model, not a clamped step");
assert.deepEqual(step("Wait 2 seconds"), { tool: "wait", ms: 2000 });
assert.deepEqual(step("Wait 1.5 seconds"), { tool: "wait", ms: 1500 });
assert.equal(parsePhrase("Wait 30 seconds"), null);
assert.deepEqual(step("Go back"), { tool: "back" });
assert.deepEqual(step("Press return"), { tool: "key", key: "return" });
assert.deepEqual(step("Hide the keyboard"), { tool: "key", key: "dismiss" });
assert.deepEqual(step('Long press "Report.pdf"'), { tool: "long_press", label: "Report.pdf" });
assert.deepEqual(step('Drag "A" to "B"'), { tool: "drag", from: "A", to: "B" });
assert.deepEqual(step("Open the app"), { tool: "open" });
assert.deepEqual(step("Restart the app"), { tool: "open", relaunch: true });
assert.deepEqual(step("Open the app fresh"), { tool: "open", reset: true });

// The review shows the sentence as "Expected: ..." because a person judges it; losing it leaves a screenshot with no question.
assert.deepEqual(parsePhrase("Check the folder QA-T1 is in the list"), { step: { tool: "look" }, expected: "the folder QA-T1 is in the list" });
assert.equal(parsePhrase("Make sure that the title says Files.").expected, "the title says Files");
assert.equal(parsePhrase("verify Settings is open").expected, "Settings is open");
assert.equal(parsePhrase("Expect the list to be empty").expected, "the list to be empty");

// A grammar that over-matches turns a goal into a wrong exact step.
assert.equal(parsePhrase("make a new folder called QA-T1"), null);
assert.equal(parsePhrase("open the About page"), null);
assert.equal(parsePhrase('tap the Files tab'), null, "an unquoted label is not an exact label");
assert.equal(parsePhrase("Checkout the cart"), null, "check needs a word boundary");
assert.equal(parsePhrase("Check"), null);

// The sheet is written in Vietnamese with 'single quotes'. A tester should not have to translate it, and it must give the
// same step as the English line, or the same case would behave differently depending on the language it was typed in.
for (const [vi, en] of [
  ["Chạm 'Image to PDF'", 'Tap "Image to PDF"'],
  ["Nhấn vào 'Done'.", 'Tap "Done"'],
  ["Bấm “Done”", 'Tap "Done"'],
  ["Chạm vào ô thứ 2 'Folder'", 'Tap the 2nd "Folder"'],
  ["Nhập 'Invoice Q3' vào 'Name'", 'Type "Invoice Q3" into "Name"'],
  ["Nhập 'cats' vào 'Search' và nhấn return", 'Type "cats" into "Search" and press return'],
  ["Cuộn xuống 3 lần", "Scroll down 3 times"],
  ["Cuộn lên", "Scroll up"],
  ["Quay lại", "Go back"],
  ["Chờ 2 giây", "Wait 2 seconds"],
  ["Chờ 1,5 giây", "Wait 1.5 seconds"],
  ["Nhấn giữ 'Report.pdf'", 'Long press "Report.pdf"'],
  ["Kéo 'A' tới 'B'", 'Drag "A" to "B"'],
  ["Kéo 'A' sang 'B'", 'Drag "A" to "B"'],
  ["Mở lại ứng dụng", "Restart the app"],
  ["Mở ứng dụng mới", "Open the app fresh"],
  ["Ẩn bàn phím", "Hide the keyboard"],
]) assert.deepEqual(parsePhrase(vi)?.step, parsePhrase(en)?.step, `${vi} = ${en}`);
assert.deepEqual(step("Cham 'Image to PDF'"), { tool: "tap", label: "Image to PDF" }, "a tester without a Vietnamese keyboard still gets the step");
assert.deepEqual(step("CHẠM 'Done'"), { tool: "tap", label: "Done" });
assert.deepEqual(step("Tap 'Files'"), { tool: "tap", label: "Files" }, "single quotes work in English too");
assert.deepEqual(step("Tap ‘Files’"), { tool: "tap", label: "Files" });
assert.deepEqual(step("Tap \"Don't Allow\""), { tool: "tap", label: "Don't Allow" }, "an apostrophe inside a label is part of the label");
assert.equal(parsePhrase("Chạm 'Don't Allow'"), null, "an ambiguous quote goes to the model instead of cutting the label in two");
// A swipe names where the finger goes; the screen scrolls the other way. Wrong here swipes every pager test backwards.
assert.deepEqual(step("Vuốt sang trái"), { tool: "scroll", direction: "right" });
assert.deepEqual(step("Vuốt lên 2 lần"), { tool: "scroll", direction: "down", times: 2 });
assert.equal(parsePhrase("Vuốt trang chính từ trang 1 sang trang 2"), null, "no direction word: not a fixed phrase");
assert.equal(parsePhrase("Cuộn xuống 40 lần"), null);
assert.equal(parsePhrase("Chờ 30 giây"), null);

// A Vietnamese check keeps the sentence as the expected result, and "xác nhận" before a button name is a tap, not a check.
assert.deepEqual(parsePhrase("Kiểm tra trang 2 bị xóa, còn 2 trang."), { step: { tool: "look" }, expected: "trang 2 bị xóa, còn 2 trang" });
assert.equal(parsePhrase("Xác nhận rằng danh sách rỗng").expected, "danh sách rỗng");
assert.equal(parsePhrase("Mong đợi Detail Project mở với 5 trang").expected, "Detail Project mở với 5 trang");
assert.equal(parsePhrase("Xác nhận 'Delete'"), null, "confirming a dialog button is not a check");
assert.equal(parsePhrase("Kiểm tra"), null);
assert.equal(parsePhrase("Chọn ảnh C"), null, "an unquoted name is not an exact label");
assert.ok(isComment("# Bước 1"));

// A check about a saved file is answered by code, so it must be told apart from a check about the screen.
{
  const file = (line) => parsePhrase(line)?.file;
  assert.deepEqual(file('Check the file "Doc.pdf" exists'), { name: "Doc.pdf", op: "exists" });
  assert.deepEqual(file("Kiểm tra file 'Document_30_09_2026.pdf' tồn tại"), { name: "Document_30_09_2026.pdf", op: "exists" });
  assert.deepEqual(file('Check the file "a.pdf" has 3 pages'), { name: "a.pdf", op: "pages", n: 3 });
  assert.deepEqual(file("Kiểm tra file 'a.pdf' có 3 trang"), { name: "a.pdf", op: "pages", n: 3 });
  assert.deepEqual(file("Kiểm tra tệp 'a.pdf' là A4 dọc"), { name: "a.pdf", op: "a4", orientation: "portrait" });
  assert.deepEqual(file("Kiểm tra file 'a.pdf' là A4 ngang"), { name: "a.pdf", op: "a4", orientation: "landscape" });
  assert.deepEqual(file('Verify the file "a.pdf" is A4'), { name: "a.pdf", op: "a4" });
  assert.deepEqual(file("Kiểm tra file 'a.pdf' có màu xám"), { name: "a.pdf", op: "gray" });
  assert.deepEqual(file('Check the file "a.pdf" is grayscale'), { name: "a.pdf", op: "gray" });
  assert.deepEqual(file("Kiểm tra file 'a.pdf' có màu"), { name: "a.pdf", op: "color" }, "'có màu' is colour, 'có màu xám' is gray");
  assert.deepEqual(file("Kiểm tra file 'a.pdf' nhỏ hơn 'b.pdf'"), { name: "a.pdf", op: "smaller", other: "b.pdf" });
  assert.deepEqual(file('Check the file "a.pdf" is locked'), { name: "a.pdf", op: "locked" });
  assert.deepEqual(file("Kiểm tra file 'a.pdf': các trang theo đúng thứ tự C, A, B"), { name: "a.pdf", op: "visual", about: "các trang theo đúng thứ tự C, A, B" });
  assert.equal(parsePhrase("Kiểm tra file 'a.pdf' có 3 trang").expected, "file 'a.pdf' có 3 trang", "the sentence stays as the expected result");
  assert.deepEqual(parsePhrase("Kiểm tra file 'a.pdf' có 3 trang").step, { tool: "look" });
  // A sentence that only mentions a file is a screen check.
  assert.equal(file("Check the file list is empty"), undefined);
  assert.equal(file("Kiểm tra file 'a.pdf' được hiển thị trong danh sách"), undefined, "a file shown in the list is a screen check");
  assert.equal(parsePhrase("Kiểm tra file 'a.pdf' được hiển thị trong danh sách").expected, "file 'a.pdf' được hiển thị trong danh sách");
}

// Zoom is a pinch: in is above 1, out is below 1, and a factor the step cannot do is not guessed.
assert.deepEqual(step("Zoom in"), { tool: "pinch", scale: 2 });
assert.deepEqual(step("Zoom out"), { tool: "pinch", scale: 0.5 });
assert.deepEqual(step("Pinch open 3 times"), { tool: "pinch", scale: 3 });
assert.deepEqual(step("Phóng to"), { tool: "pinch", scale: 2 });
assert.deepEqual(step("Phóng to 3 lần"), { tool: "pinch", scale: 3 });
assert.deepEqual(step("Thu nhỏ"), { tool: "pinch", scale: 0.5 });
assert.deepEqual(step("Thu nho 4 lần"), { tool: "pinch", scale: 0.25 });
assert.equal(parsePhrase("Phóng to 9 lần"), null);
assert.equal(parsePhrase("Zoom in 1 time"), null);

assert.ok(isComment(""));
assert.ok(isComment("   "));
assert.ok(isComment("# set up"));
assert.ok(!isComment('Tap "Files"'));
console.log("test-phrases: ok");
