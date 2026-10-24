import type { FrontendPlugin } from "@trame/web-api";
import { CODE_CELL } from "./CodeBlock";
import { NotebookCellsPageHeader } from "./Export";
import { NotebookCellsSettings } from "./Settings";

export default {
  id: "notebook-cells",
  Settings: NotebookCellsSettings,
  PageHeader: NotebookCellsPageHeader,
  blocks: [CODE_CELL],
} satisfies FrontendPlugin;
