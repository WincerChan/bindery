export function NotFoundPage(props: { data?: unknown }) {
  return <div role="alert"><h1>{typeof props.data === "string" ? props.data : "页面不存在"}</h1><p><a href="/">返回书库</a></p></div>;
}
