declare module "jszip" {
  interface JSZipFile {
    async(type: "string" | "nodebuffer"): Promise<any>;
  }

  class JSZip {
    static loadAsync(data: Buffer): Promise<JSZip>;
    files: Record<string, { dir?: boolean } | undefined>;
    file(path: string): JSZipFile | null;
    file(path: string, data: string | Buffer): JSZip;
    generateAsync(options: { type: "nodebuffer" }): Promise<Buffer>;
  }

  export default JSZip;
}

declare module "@xmldom/xmldom" {
  export class DOMParser {
    parseFromString(xml: string, mimeType: string): Document;
  }

  export class XMLSerializer {
    serializeToString(node: Node): string;
  }
}

declare module "better-sqlite3" {
  class Database {
    constructor(path: string);
    close(): void;
  }

  namespace Database {
    export type Database = InstanceType<typeof Database>;
  }

  export default Database;
}
