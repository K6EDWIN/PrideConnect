import EventDetail from "./event-detail";

export default async function EventDetailPage({ params, searchParams }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const requestedReturnTo = Array.isArray(query?.returnTo) ? query.returnTo[0] : query?.returnTo;
  const returnTo = typeof requestedReturnTo === "string" && (requestedReturnTo === "/events" || requestedReturnTo.startsWith("/events?"))
    ? requestedReturnTo
    : "/events";
  return <EventDetail eventId={id} returnTo={returnTo} />;
}
