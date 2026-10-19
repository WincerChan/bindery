import { renderToString } from "@solidjs/web";
import { IngestPage } from "../../../src/features/ingest/page";
import { UploadPreviews } from "../../../src/features/ingest/preview";
import { JobsSection } from "../../../src/features/ingest/jobs";
import type { Preview } from "../../../src/server/ingest/preview";
import type { JobsPayload } from "../../../src/server/ingest/queries";
export const ingest = () => renderToString(() => <IngestPage options={{ rules: [{ rule_id: "default", name: "默认", version: "1" }], themes: [{ theme_id: "default", name: "默认样式", version: "1" }] }} />);
export const previews = (previews: Preview[]) => renderToString(() => <UploadPreviews previews={previews} />);
export const jobs = (data: JobsPayload) => renderToString(() => <JobsSection data={data} />);
