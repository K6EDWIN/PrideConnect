import { withAuth } from "next-auth/middleware";

export default withAuth({
  callbacks: {
    authorized: ({ token, req }) => {
      // Unauthenticated requests are blocked and redirected to login
      if (!token) return false;

      // Suspended accounts are immediately denied and redirected to login
      if (token.isSuspended) return false;
      if (token.isDeleted) return false;

      // Admin route guard: only administrators can access /admin
      if (req.nextUrl.pathname.startsWith("/admin") && token.role !== "ADMIN") {
        return false;
      }

      return true;
    },
  },
  pages: {
    signIn: "/login",
  },
});

export const config = {
  matcher: [
    "/recommendations/:path*",
    "/directory/:path*",
    "/flight-reconnect/:path*",
    "/requests/:path*",
    "/opportunities/:path*",
    "/events/:path*",
    "/profile/:path*",
    "/admin/:path*",
  ],
};
