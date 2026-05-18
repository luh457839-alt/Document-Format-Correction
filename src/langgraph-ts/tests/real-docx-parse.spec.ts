import { afterEach, describe, expect, it } from "vitest";
import {
  REAL_DOCX_SAMPLES,
  collectBundleHealth,
  createRealDocxFixture
} from "./real-docx-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("real docx parse health", () => {
  for (const sample of REAL_DOCX_SAMPLES) {
    it(`parses ${sample.name} with stable package and structure metrics`, async () => {
      const fixture = await createRealDocxFixture(sample);
      cleanups.push(() => fixture.cleanup());

      expect(collectBundleHealth(fixture.bundle)).toEqual(sample.expected);
    });
  }
});
