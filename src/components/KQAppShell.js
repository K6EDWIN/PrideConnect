"use client";

import { useSession, signOut } from "next-auth/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KQLogo, Avatar } from "./KQBrand";
import { Icon } from "./KQIcons";
import { ViewModeToggle } from "./ViewMode";
import { profilePathForRole } from "@/lib/profile-navigation";
import { readApiResponse } from "@/lib/read-api-response";

export default function KQAppShell({ children }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const profileHref = profilePathForRole(session?.user?.role);

  useEffect(() => {
    if (!session?.user?.id) return undefined;
    let active = true;
    const refresh = () =>
      fetch("/api/notifications", { cache: "no-store" })
        .then((res) => (res.ok ? readApiResponse(res, "Could not refresh notifications") : null))
        .then((data) => {
          if (active && data) setUnreadCount(data.unreadCount || 0);
        })
        .catch(() => {});
    const onNotificationsPage = pathname === "/notifications";
    if (!onNotificationsPage) refresh();
    const interval = onNotificationsPage ? null : setInterval(refresh, 60000);
    window.addEventListener("notifications-updated", refresh);
    return () => {
      active = false;
      if (interval) clearInterval(interval);
      window.removeEventListener("notifications-updated", refresh);
    };
  }, [session?.user?.id, pathname]);

  const navSections = [
    {
      heading: "Matching & Discovery",
      items: [
        { href: "/recommendations", icon: "sparkles", label: "Smart Matches", badge: "AI" },
        { href: "/directory", icon: "directory", label: "Stakeholder Directory" },
        { href: "/requests", icon: "requests", label: "Mentorship & Requests" },
        { href: "/messages", icon: "message", label: "Messages" },
        { href: "/notifications", icon: "bell", label: "Notifications", badge: unreadCount ? String(unreadCount) : null },
      ],
    },
    {
      heading: "Ecosystem & Hubs",
      items: [
        { href: "/flight-reconnect", icon: "flight", label: "Flight Reconnect", badge: "35k Ft" },
        { href: "/opportunities", icon: "opportunity", label: "Aviation Opportunities" },
        { href: "/events", icon: "events", label: "Pride Centre Events" },
      ],
    },
    {
      heading: "Account",
      items: [
        { href: profileHref, icon: "profile", label: session?.user?.role === "ADMIN" ? "Admin Profile" : "My Profile" },
      ],
    },
  ];

  if (session?.user?.role === "ADMIN") {
    navSections.push({
      heading: "Governance & Ops",
      items: [
        { href: "/admin", icon: "shield", label: "Ops Command / Admin", badge: "Secured" },
        { href: "/admin/frequent-flyers", icon: "flight", label: "Asante Member Reviews" },
      ],
    });
  }

  const roleLabels = {
    ALUMNI: "Pride Centre Alumni",
    STAFF: "Active Flight & Ground Staff",
    FORMER_STAFF: "Former KQ Staff",
    FREQUENT_FLYER: "Frequent Flyer • Asante",
    ADMIN: "System Administrator",
  };

  const allNavItems = navSections.flatMap((s) => s.items);
  const activeMobileHref = allNavItems.find((item) =>
    pathname === item.href || pathname.startsWith(`${item.href}/`)
  )?.href || "";

  const handleMobileNav = (e) => {
    const target = e.target.value;
    if (target === "LOGOUT") {
      signOut({ callbackUrl: "/login" });
      return;
    }
    router.push(target);
  };

  return (
    <div className="shell">
      <a className="app-skip-link" href="#main-content">Skip to main content</a>
      {/* Sidebar Navigation */}
      <aside className="sidebar">
        <div className="flex items-center justify-between mb-5 px-1">
          <KQLogo light />
          <span className="px-2 py-0.5 rounded-full bg-[#13283f] text-[#d5e4fa] text-[10px] font-mono tracking-wider">
            v2.4
          </span>
        </div>

        <nav className="flex-1 overflow-y-auto">
          {navSections.map((section, idx) => (
            <div key={idx} className="mb-4">
              <div className="sidebar-nav-heading flex items-center justify-between">
                <span>{section.heading}</span>
              </div>
              <div className="space-y-1">
                {section.items.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                      aria-current={isActive ? "page" : undefined}
                    >
                      <Icon name={item.icon} size={16} />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.badge && <span className="nav-badge">{item.badge}</span>}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {session?.user && (
          <div className="sidebar-profile mt-auto">
            <Link
              href={profileHref}
              className="flex items-center gap-2.5 overflow-hidden flex-1 min-w-0 hover:opacity-95 transition"
              title="View your profile"
            >
              <div className="relative shrink-0">
                <Avatar
                  name={session.user.name || session.user.email}
                  src={session.user.image}
                  userId={session.user.id}
                  size="sm"
                  role={session.user.role}
                />
                <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-[#071626]" />
              </div>
              <div className="truncate flex-1 min-w-0">
                <b className="truncate text-white text-xs block font-semibold leading-tight">
                  {session.user.name || session.user.email?.split("@")[0]}
                </b>
                <small className="text-[#94a3b8] text-[11px] block truncate leading-tight mt-0.5">
                  {roleLabels[session.user.role] || "Verified Member"}
                </small>
              </div>
            </Link>

            {/* Dedicated Log Out button in sidebar */}
            <button
              type="button"
              onClick={() => signOut({ callbackUrl: "/login" })}
              title="Log out of Kenya Airways PrideConnect"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#0e2740] hover:bg-[#c8102e] text-slate-300 hover:text-white text-xs font-semibold transition ml-2 shrink-0 border border-[#1e3a5f] hover:border-transparent cursor-pointer shadow-xs"
            >
              <Icon name="logout" size={14} />
              <span className="text-[11px] font-medium hidden 2xl:inline">Log out</span>
            </button>
          </div>
        )}
      </aside>

      {/* Main Content Area */}
      <div className="shell-main">
        <header className="app-header">
          {/* Mobile view brand + switcher */}
          <div className="mobile-brand flex items-center gap-2">
            <KQLogo compact />
            <select
              aria-label="Navigate section"
              onChange={handleMobileNav}
              value={activeMobileHref}
              className="px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-xs font-medium text-slate-700 outline-none max-w-[150px] sm:max-w-[200px]"
            >
              {!activeMobileHref && <option value="" disabled>Choose a section</option>}
              {navSections.map((section) => (
                <optgroup key={section.heading} label={section.heading}>
                  {section.items.map((item) => (
                    <option key={item.href} value={item.href}>{item.label}</option>
                  ))}
                </optgroup>
              ))}
              {session?.user && <option value="LOGOUT">➔ Log out</option>}
            </select>
            {session?.user && (
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: "/login" })}
                aria-label="Log out"
                className="p-1.5 text-slate-600 hover:text-[#c8102e] rounded-md transition hover:bg-slate-100"
                title="Log out"
              >
                <Icon name="logout" size={16} />
              </button>
            )}
          </div>

          {/* Desktop Left: Enterprise Status Indicator */}
          <div className="hidden lg:flex items-center gap-2.5 text-xs text-slate-500 font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="font-semibold text-slate-700">Kenya Airways Pride Centre</span>
            <span className="text-slate-300">|</span>
            <span className="text-slate-500">Enterprise Network</span>
          </div>

          {/* Header Action Tools */}
          <div className="header-right flex items-center gap-2.5">
            <ViewModeToggle compact />
            <Link
              href="/directory"
              className="icon-btn"
              aria-label="Search stakeholder directory"
              title="Search Stakeholder Directory"
            >
              <Icon name="search" size={16} />
            </Link>
            <Link
              href="/notifications"
              className="icon-btn relative"
              aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
              title="Notifications"
            >
              <Icon name="bell" size={16} />
              {unreadCount > 0 && (
                <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-[#c8102e] text-white text-[9px] leading-4 text-center font-bold">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </Link>

            {session?.user ? (
              <div className="flex items-center gap-2 pl-1 border-l border-slate-200">
                <Link
                  href={profileHref}
                  className="flex items-center gap-2 hover:opacity-90 transition p-1 rounded-lg"
                  title="My Profile"
                >
                  <Avatar
                    name={session.user.name || session.user.email}
                      src={session.user.image}
                      userId={session.user.id}
                    size="sm"
                    role={session.user.role}
                  />
                  <span className="hidden xl:inline text-xs font-semibold text-slate-800 truncate max-w-[120px]">
                    {session.user.name || session.user.email?.split("@")[0]}
                  </span>
                </Link>

                {/* Primary Visible Header Log Out Button */}
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: "/login" })}
                  title="Log out of PrideConnect"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 hover:border-red-200 hover:bg-red-50 text-slate-700 hover:text-[#c8102e] text-xs font-semibold transition cursor-pointer shadow-xs"
                >
                  <Icon name="logout" size={14} className="text-slate-500 group-hover:text-[#c8102e]" />
                  <span>Log out</span>
                </button>
              </div>
            ) : (
              <Link href="/login" className="btn btn-primary btn-sm">
                Sign In
              </Link>
            )}
          </div>
        </header>

        <main id="main-content" className="flex-1 bg-[#f8fafc]">{children}</main>
      </div>
    </div>
  );
}
