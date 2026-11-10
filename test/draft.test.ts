import { test } from "node:test";
import assert from "node:assert/strict";
import { latestReplyText } from "../lib/draft.js";

test("strips quoted history from a reply", () => {
  const raw = "What times work this week?\n\nOn Tue, Nov 10, 2026 at 8:49 AM Christian Gaudio <x@y.com> wrote:\n> Lets Book\n>\n> On Mon wrote:\n>> Alright";
  assert.equal(latestReplyText(raw), "What times work this week?");
});

test("keeps the text when nothing is quoted", () => {
  assert.equal(latestReplyText("Sure, Tuesday works."), "Sure, Tuesday works.");
});
