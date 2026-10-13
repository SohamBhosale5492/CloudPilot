export type KnownRoute = "/health" | "/api/demo" | "unmatched";

export interface RouteInfo {
  route: KnownRoute;
  statusCode: number;
  contentType: string;
  body: string;
}

export function classifyRoute(pathname: string): KnownRoute {
  if (pathname === "/health") {
    return "/health";
  }

  if (pathname === "/api/demo") {
    return "/api/demo";
  }

  return "unmatched";
}

export function buildResponse(route: KnownRoute): RouteInfo {
  if (route === "/health") {
    return {
      route,
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ status: "healthy" })
    };
  }

  if (route === "/api/demo") {
    return {
      route,
      statusCode: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        service: "demo-service",
        phase: "01",
        message: "deterministic demo response"
      })
    };
  }

  return {
    route,
    statusCode: 404,
    contentType: "application/json; charset=utf-8",
    body: JSON.stringify({ error: "not_found" })
  };
}
