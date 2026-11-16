import { test, expect } from "@playwright/test";

const PHONE_ORIGIN = "http://phone.localhost:5173";

const AUTH_REQUIRED = {
  detail: {
    code: "api_auth_required",
    message: "Open RouterChat through its launcher to authorize this browser.",
  },
};

async function installUnpairedApi(page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify(AUTH_REQUIRED),
    }),
  );
}

test("a fresh pairing link replaces the code in an already open pairing tab", async ({ page }) => {
  await installUnpairedApi(page);
  await page.goto(`${PHONE_ORIGIN}/#pair=AAAA-1111`);

  const codeField = page.getByLabel("Pairing code");
  await expect(codeField).toHaveValue("AAAA-1111");
  await expect(page).toHaveURL(`${PHONE_ORIGIN}/`);

  await page.goto(`${PHONE_ORIGIN}/#pair=BBBB-2222`);

  await expect(codeField).toHaveValue("BBBB-2222");
  await expect(page).toHaveURL(`${PHONE_ORIGIN}/`);
});

test("a link without a pairing code keeps the typed code", async ({ page }) => {
  await installUnpairedApi(page);
  await page.goto(`${PHONE_ORIGIN}/`);

  const codeField = page.getByLabel("Pairing code");
  await codeField.fill("CCCC-3333");

  await page.goto(`${PHONE_ORIGIN}/#somewhere`);

  await expect(page).toHaveURL(`${PHONE_ORIGIN}/`);
  await expect(codeField).toHaveValue("CCCC-3333");
});
