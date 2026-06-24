/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#f4f4f5",
        muted: "#a1a1aa",
        line: "rgba(255,255,255,0.09)",
        panel: "#111113",
        lift: "#18181b",
        accent: "#60a5fa",
      },
      boxShadow: {
        composer: "0 22px 80px rgba(0, 0, 0, 0.45)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
