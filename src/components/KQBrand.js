"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useState } from "react";
import { Icon } from "./KQIcons";

export function KQLogo({ compact = false, light = false }) {
  return (
    <Link href="/" className={`logo inline-flex items-center gap-3 ${light ? "logo-light" : ""}`} aria-label="KQ PrideConnect home">
      <Image src="/prideconnect-mark.svg" alt={compact ? "KQ PrideConnect" : ""} width={38} height={38} className="logo-mark" unoptimized />
      {!compact && (
        <span className="logo-copy flex flex-col leading-tight">
          <b className={`text-sm font-bold tracking-tight ${light ? "text-white" : "text-[#071626]"}`}>
            KQ PrideConnect
          </b>
          <small className={`text-[10px] tracking-wider uppercase font-semibold ${light ? "text-slate-400" : "text-slate-500"}`}>
            Kenya Airways Ecosystem
          </small>
        </span>
      )}
    </Link>
  );
}

export function Button({
  children,
  className = "",
  icon,
  onClick,
  type = "button",
  disabled = false,
  variant = "primary",
  size = "md",
}) {
  const sizeClass = size === "sm" ? "btn-sm" : size === "lg" ? "btn-lg" : "";
  return (
    <button
      type={type}
      disabled={disabled}
      className={`btn btn-${variant} ${sizeClass} ${className} ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={size === "sm" ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Tag({ children, gold = false, crimson = false, emerald = false, className = "" }) {
  let variantClass = "";
  if (gold) variantClass = "tag-gold";
  else if (crimson) variantClass = "tag-crimson";
  else if (emerald) variantClass = "tag-emerald";

  return <span className={`tag ${variantClass} ${className}`}>{children}</span>;
}

export function Avatar({ name = "KQ Member", src, size = "md", role, userId, className = "" }) {
  const [activeSrc, setActiveSrc] = useState(src || null);

  useEffect(() => {
    const checkCustom = () => {
      try {
        const stored = userId ? localStorage.getItem(`kq_user_avatar:${userId}`) : null;
        setActiveSrc(stored || src || null);
      } catch (e) {}
    };
    checkCustom();
    window.addEventListener("kq-avatar-updated", checkCustom);
    window.addEventListener("storage", checkCustom);
    return () => {
      window.removeEventListener("kq-avatar-updated", checkCustom);
      window.removeEventListener("storage", checkCustom);
    };
  }, [src, userId]);

  const initials = (name || "KQ Member")
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // Role accent colors for authentic airline directory feel
  const roleColors = {
    STAFF: "bg-[#0e2740] text-white", // KQ Midnight
    ALUMNI: "bg-[#c8102e] text-white", // KQ Crimson
    FREQUENT_FLYER: "bg-[#c59b27] text-white", // Gold
    FORMER_STAFF: "bg-[#334155] text-white", // Slate
    ADMIN: "bg-[#0f172a] text-white",
  };

  const bgClass = role ? roleColors[role] || "bg-[#0e2740] text-white" : "bg-[#0e2740] text-white";

  const sizeStyles = {
    sm: "w-8 h-8 text-[11px]",
    md: "w-10 h-10 text-[13px]",
    lg: "w-12 h-12 text-[15px]",
    xl: "w-20 h-20 text-[22px]",
  };

  const sizeClass = sizeStyles[size] || sizeStyles.md;

  if (activeSrc) {
    return (
      <Image
        alt={name}
        className={`avatar rounded-full object-cover border border-slate-200/80 shadow-xs ${sizeClass} ${className}`}
        src={activeSrc}
        width={80}
        height={80}
        unoptimized
        onError={() => setActiveSrc(null)}
      />
    );
  }

  return (
    <div
      className={`avatar flex items-center justify-center font-bold select-none rounded-full shadow-xs ${bgClass} ${sizeClass} ${className}`}
      title={name}
    >
      {initials || "KQ"}
    </div>
  );
}
