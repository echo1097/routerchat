/** @type {import('tailwindcss').Config} */
export default {
  content: ["./frontend/index.html", "./frontend/src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#f5f5f5",
        muted: "#a3a3a3",
        line: "rgba(255,255,255,0.09)",
        panel: "#111111",
        lift: "#181818",
        accent: "#d4d4d4",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
