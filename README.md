# Mitosia

A [Next.js](https://nextjs.org) app using the App Router, [Tailwind CSS v4](https://tailwindcss.com), and [shadcn/ui](https://ui.shadcn.com) (Base UI, `base-rhea` style, RTL-ready).

## Getting Started

Install dependencies and run the development server:

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Edit `app/page.tsx` to start building — the page hot-reloads as you save.

## Scripts

| Script       | Description                              |
| ------------ | ---------------------------------------- |
| `pnpm dev`   | Start the development server             |
| `pnpm build` | Create a production build                |
| `pnpm start` | Serve the production build               |
| `pnpm lint`  | Check code with Ultracite (Biome)        |
| `pnpm fix`   | Auto-format and fix issues with Ultracite |

## Stack Notes

- **Fonts** — [Google Sans](https://fonts.google.com/specimen/Google+Sans) (sans) and [Google Sans Code](https://fonts.google.com/specimen/Google+Sans+Code) (mono), self-hosted via `next/font`.
- **Linting/formatting** — [Ultracite](https://ultracite.ai) (Biome preset). No ESLint or Prettier.
- **Components** — add shadcn/ui components with `pnpm dlx shadcn@latest add <component>`.
- **RTL** — components use logical properties; the `DirectionProvider` is wired in `app/layout.tsx`. To render right-to-left, set `dir="rtl"` on `<html>` and `direction="rtl"` on the provider ([docs](https://ui.shadcn.com/docs/rtl/next)).
