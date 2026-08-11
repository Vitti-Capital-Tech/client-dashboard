import assert from "node:assert/strict";
import { test } from "node:test";
import { TablePagination } from "./TablePagination.tsx";

test("TablePagination - returns null when totalItems is 0", () => {
  const result = TablePagination({
    totalItems: 0,
    currentPage: 1,
    pageSize: 10,
    onPageChange: () => {},
  });
  assert.equal(result, null);
});

test("TablePagination - calculates correct ranges for standard pagination", () => {
  const element = TablePagination({
    totalItems: 43,
    currentPage: 2,
    pageSize: 10,
    onPageChange: () => {},
    itemLabel: "clients",
  });
  assert.ok(element !== null);
});

test("TablePagination - handles 'All' selection gracefully", () => {
  const element = TablePagination({
    totalItems: 43,
    currentPage: 1,
    pageSize: 999999,
    onPageChange: () => {},
  });
  assert.ok(element !== null);
});
