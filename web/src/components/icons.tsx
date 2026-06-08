/* SiteMapper icons — 16px stroke icons, currentColor (ported from icons.jsx) */
import React from "react";

interface SProps {
  d?: string;
  size?: number;
  fill?: string;
  vb?: number;
  sw?: number;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

const S = ({ d, size = 16, fill, vb = 24, sw = 1.8, children, style }: SProps) =>
  React.createElement(
    "svg",
    {
      width: size, height: size, viewBox: `0 0 ${vb} ${vb}`,
      fill: fill || "none", stroke: fill ? "none" : "currentColor",
      strokeWidth: sw, strokeLinecap: "round", strokeLinejoin: "round",
      style, className: "ico",
    },
    children || React.createElement("path", { d })
  );

type IconFn = (p: { size?: number; style?: React.CSSProperties }) => React.ReactElement;

const I: Record<string, IconFn> = {
  dashboard: (p) => S({ ...p, children: [
    React.createElement("rect", { key: 1, x: 3, y: 3, width: 7, height: 9, rx: 1.5 }),
    React.createElement("rect", { key: 2, x: 14, y: 3, width: 7, height: 5, rx: 1.5 }),
    React.createElement("rect", { key: 3, x: 14, y: 12, width: 7, height: 9, rx: 1.5 }),
    React.createElement("rect", { key: 4, x: 3, y: 16, width: 7, height: 5, rx: 1.5 }),
  ] }),
  sitemap: (p) => S({ ...p, children: [
    React.createElement("rect", { key: 1, x: 9, y: 2.5, width: 6, height: 5, rx: 1.2 }),
    React.createElement("rect", { key: 2, x: 2.5, y: 16.5, width: 6, height: 5, rx: 1.2 }),
    React.createElement("rect", { key: 3, x: 15.5, y: 16.5, width: 6, height: 5, rx: 1.2 }),
    React.createElement("path", { key: 4, d: "M12 7.5v4M12 11.5H5.5v5M12 11.5h6.5v5" }),
  ] }),
  pages: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M5 3.5h9l5 5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" }),
    React.createElement("path", { key: 2, d: "M14 3.5V8a1 1 0 0 0 1 1h4M7.5 13h7M7.5 16.5h7" }),
  ] }),
  links: (p) => S({ ...p, children: [
    React.createElement("circle", { key: 1, cx: 6, cy: 6, r: 2.6 }),
    React.createElement("circle", { key: 2, cx: 18, cy: 7, r: 2.6 }),
    React.createElement("circle", { key: 3, cx: 12, cy: 18, r: 2.6 }),
    React.createElement("path", { key: 4, d: "M8.3 7.2 11 16M16 9l-2.6 6.6" }),
  ] }),
  errors: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M12 3.2 21 19H3L12 3.2Z" }),
    React.createElement("path", { key: 2, d: "M12 9.5v4M12 16.5h.01" }),
  ] }),
  redirects: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M4 8h11l-3-3M4 8l3 3M20 16H9l3 3M20 16l-3-3" }),
  ] }),
  export: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M12 15V4M12 4 8.5 7.5M12 4l3.5 3.5" }),
    React.createElement("path", { key: 2, d: "M5 14v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" }),
  ] }),
  search: (p) => S({ ...p, children: [
    React.createElement("circle", { key: 1, cx: 10.5, cy: 10.5, r: 6.5 }),
    React.createElement("path", { key: 2, d: "m20 20-4.8-4.8" }),
  ] }),
  chevron: (p) => S({ ...p, d: "m9 6 6 6-6 6" }),
  chevronDown: (p) => S({ ...p, d: "m6 9 6 6 6-6" }),
  expand: (p) => S({ ...p, d: "m7 10 5 5 5-5" }),
  filter: (p) => S({ ...p, d: "M4 5h16l-6 7v6l-4 2v-8L4 5Z" }),
  external: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M14 4h6v6M20 4l-8 8" }),
    React.createElement("path", { key: 2, d: "M18 13.5V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5.5" }),
  ] }),
  copy: (p) => S({ ...p, children: [
    React.createElement("rect", { key: 1, x: 8, y: 8, width: 12, height: 12, rx: 2 }),
    React.createElement("path", { key: 2, d: "M16 8V5a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h3" }),
  ] }),
  link: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M9.5 13.5 14.5 8.5" }),
    React.createElement("path", { key: 2, d: "M8 11 6 13a3.5 3.5 0 0 0 5 5l2-2" }),
    React.createElement("path", { key: 3, d: "M16 13l2-2a3.5 3.5 0 0 0-5-5l-2 2" }),
  ] }),
  arrowRight: (p) => S({ ...p, d: "M5 12h14M13 6l6 6-6 6" }),
  refresh: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M20 11a8 8 0 1 0-1.5 5" }),
    React.createElement("path", { key: 2, d: "M20 4v5h-5" }),
  ] }),
  settings: (p) => S({ ...p, children: [
    React.createElement("circle", { key: 1, cx: 12, cy: 12, r: 3 }),
    React.createElement("path", { key: 2, d: "M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3" }),
  ] }),
  dot: (p) => S({ ...p, fill: "currentColor", children: [React.createElement("circle", { key: 1, cx: 12, cy: 12, r: 4 })] }),
  folder: (p) => S({ ...p, d: "M3 6.5a1 1 0 0 1 1-1h5l2 2h8a1 1 0 0 1 1 1V18a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6.5Z" }),
  file: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M6 3.5h7l5 5V19a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" }),
    React.createElement("path", { key: 2, d: "M13 3.5V8a1 1 0 0 0 1 1h4" }),
  ] }),
  home: (p) => S({ ...p, d: "M4 11 12 4l8 7M6 9.5V19a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9.5" }),
  eyeOff: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M3 3l18 18M10.6 10.7a2 2 0 0 0 2.8 2.8" }),
    React.createElement("path", { key: 2, d: "M6.5 6.6C4.6 7.9 3 10 2 12c2 4 6 6 10 6 1.6 0 3.1-.3 4.5-1M9.8 5.2A10 10 0 0 1 12 5c4 0 8 2 10 7-.6 1.2-1.4 2.3-2.3 3.2" }),
  ] }),
  sort: (p) => S({ ...p, d: "M7 4v16M7 20l-3-3M7 20l3-3M17 20V4M17 4l-3 3M17 4l3 3" }),
  columns: (p) => S({ ...p, children: [
    React.createElement("rect", { key: 1, x: 3, y: 4, width: 18, height: 16, rx: 1.5 }),
    React.createElement("path", { key: 2, d: "M9 4v16M15 4v16" }),
  ] }),
  grid: (p) => S({ ...p, children: [
    React.createElement("circle", { key: 1, cx: 12, cy: 12, r: 8.5 }),
    React.createElement("path", { key: 2, d: "M12 3.5v17M3.5 12h17M5 7c2 1.4 12 1.4 14 0M5 17c2-1.4 12-1.4 14 0" }),
  ] }),
  check: (p) => S({ ...p, d: "M5 12.5 10 17 19 6.5" }),
  close: (p) => S({ ...p, d: "M6 6l12 12M18 6 6 18" }),
  plus: (p) => S({ ...p, d: "M12 5v14M5 12h14" }),
  bell: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z" }),
    React.createElement("path", { key: 2, d: "M10 19a2 2 0 0 0 4 0" }),
  ] }),
  layers: (p) => S({ ...p, children: [
    React.createElement("path", { key: 1, d: "M12 3 3 8l9 5 9-5-9-5Z" }),
    React.createElement("path", { key: 2, d: "M3 13l9 5 9-5M3 16l9 5 9-5", style: { opacity: .5 } }),
  ] }),
  share: (p) => S({ ...p, children: [
    React.createElement("circle", { key: 1, cx: 6, cy: 12, r: 2.6 }),
    React.createElement("circle", { key: 2, cx: 18, cy: 6, r: 2.6 }),
    React.createElement("circle", { key: 3, cx: 18, cy: 18, r: 2.6 }),
    React.createElement("path", { key: 4, d: "m8.3 10.8 7.4-3.6M8.3 13.2l7.4 3.6" }),
  ] }),
};

export const Icon = I;
