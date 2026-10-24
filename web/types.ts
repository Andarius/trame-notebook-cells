// What a code cell stores in a page; Trame's own Block type leaves plugin blocks out.
import type { Block } from "@trame/web-api";

// nbformat output shapes, so a cell round-trips with .ipynb
export type CellOutput =
  | { output_type: "stream"; name: "stdout" | "stderr"; text: string }
  | {
    output_type: "display_data" | "execute_result";
    data: Record<string, string>;
    metadata?: Record<string, unknown>;
    execution_count?: number | null;
  }
  | { output_type: "error"; ename: string; evalue: string; traceback: string[] };

export type CodeCell = { type: "code"; source: string; outputs?: CellOutput[]; count?: number | null; id?: string };

/** a page block as this plugin reads it */
export type PageBlock = Block | CodeCell;
