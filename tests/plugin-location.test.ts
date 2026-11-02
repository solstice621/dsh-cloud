import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { canChooseLocation, LocationPicker } from "../packages/dsh-cloud-plugin/location.tsx";

test("location is offered only before a first local or cloud prompt, including in-flight transitions", () => {
  const blank = { blank: true, running: false, pendingSubmissions: [] };
  assert.equal(canChooseLocation(blank, undefined, "plain"), true);
  assert.equal(canChooseLocation(blank, { draft: true }, "plain"), true);
  assert.equal(canChooseLocation(undefined, undefined, "plain"), false);
  assert.equal(canChooseLocation(blank, undefined, undefined), false);
  for (const entry of [undefined, { draft: true }, { draft: false }]) {
    for (const phase of ["adjudicating", "submitting", "sending"])
      assert.equal(canChooseLocation(blank, entry, phase), false);
    for (const started of [{ blank: false }, { running: true }, { awaitingFirstTurn: true }, { pendingSubmissions: [{}] }])
      assert.equal(canChooseLocation({ ...blank, ...started }, entry, "plain"), false);
  }
  assert.equal(canChooseLocation(blank, { draft: false }, "plain"), false, "remote task metadata wins over stale blank state");
});

test("started sessions render no location chrome; new sessions render just one compact control", () => {
  for (const cloud of [false, true]) {
    const render = (available: boolean) => renderToStaticMarkup(React.createElement(LocationPicker, {
      available, cloud, onSelect: async () => true,
    }));
    assert.equal(render(false), "");
    const markup = render(true);
    assert.equal((markup.match(/<button /g) ?? []).length, 1);
    assert.match(markup, new RegExp(`执行位置：${cloud ? "云端" : "本地"}`));
    assert.doesNotMatch(markup, /cloud-popover|执行节点|云端结果|已同步/);
  }
});
