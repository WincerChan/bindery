import { Link } from "./spa-link";

export function NotFoundPage(props: { data?: unknown }) {
  return <div role="alert"><h1>{typeof props.data === "string" ? props.data : "页面不存在"}</h1><p><Link href="/">返回书库</Link></p></div>;
}
