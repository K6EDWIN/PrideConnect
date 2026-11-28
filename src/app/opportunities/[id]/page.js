import OpportunityDetail from "./opportunity-detail";

export default async function OpportunityDetailPage({ params, searchParams }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const requestedReturnTo = Array.isArray(query?.returnTo) ? query.returnTo[0] : query?.returnTo;
  const returnTo = typeof requestedReturnTo === "string" && (requestedReturnTo === "/opportunities" || requestedReturnTo.startsWith("/opportunities?"))
    ? requestedReturnTo
    : "/opportunities";
  return <OpportunityDetail opportunityId={id} returnTo={returnTo} />;
}
