import { test } from "node:test";
import assert from "node:assert/strict";
import { md5FromEtag } from "./etag.ts";

const md5 = "d41d8cd98f00b204e9800998ecf8427e";

test("a quoted single-part ETag is an MD5", () => {
  assert.equal(md5FromEtag(`"${md5}"`), md5);
});
test("a bare hex ETag is accepted and lowercased", () => {
  assert.equal(md5FromEtag(md5.toUpperCase()), md5);
});
test("a weak ETag is not a content hash", () => {
  assert.equal(md5FromEtag(`W/"${md5}"`), null);
});
test("a multipart ETag is not an MD5 of the body", () => {
  assert.equal(md5FromEtag(`"${md5}-3"`), null);
});
test("missing, arrays and other shapes are ignored", () => {
  assert.equal(md5FromEtag(undefined), null);
  assert.equal(md5FromEtag([`"${md5}"`]), null);
  assert.equal(md5FromEtag(`"abc"`), null);
});
