import assert from "node:assert/strict";
import test from "node:test";
import { assetRefsInText, assetRefTag, assetRefTags, canonicalAssetTags, formatAssetRef, parseAssetRef } from "../src/workflow.ts";

test("workflow asset references round-trip names, preserve exact text boundaries and read old tags", () => {
  const ref = { name: "封面 @v1 &amp; </asset>", version: "v12" };
  const tag = assetRefTag(ref);
  assert.equal(formatAssetRef(ref), "封面 @v1 &amp; </asset>@v12");
  assert.equal(tag, "<asset>封面 @v1 &amp;amp; &lt;/asset&gt;@v12</asset>");
  assert.deepEqual(parseAssetRef(formatAssetRef(ref)), ref);
  for (const invalid of ["@v1", "封面@2", "a@v0", "a@v01", "name@v2.pdf"]) assert.equal(parseAssetRef(invalid), undefined);
  const old = '<asset>{"name":"旧 &amp; 文件","version":"v2"}</asset>';
  const mixed = "before " + tag + "\\n" + old + " after";
  assert.deepEqual([...assetRefTags(mixed)].map(({ index, raw }) => mixed.slice(index, index + raw.length)), [tag, old]);
  assert.deepEqual(assetRefsInText(mixed), [ref, { name: "旧 &amp; 文件", version: "v2" }]);
  assert.equal(canonicalAssetTags(mixed), "before " + tag + "\\n<asset>旧 &amp;amp; 文件@v2</asset> after");
  assert.throws(() => assetRefsInText("<asset>bad</asset>"));
  assert.equal(canonicalAssetTags("<asset>bad</asset>"), "<asset>bad</asset>");
  const oldWithTag = { name: 'A "</asset>" \\ {B}', version: "v3" };
  const legacy = "<asset>" + JSON.stringify(oldWithTag) + "</asset>";
  assert.deepEqual(assetRefsInText(legacy + tag), [oldWithTag, ref]);
  assert.equal(canonicalAssetTags(legacy), assetRefTag(oldWithTag));
});
