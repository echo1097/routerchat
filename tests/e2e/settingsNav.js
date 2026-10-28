export async function openSettingsPage(page, name) {
  const menuToggle = page.getByRole("button", { name: "Open settings menu" });
  if (await menuToggle.isVisible()) await menuToggle.click();

  await page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name, exact: true })
    .click();
}
