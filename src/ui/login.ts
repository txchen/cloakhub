import { request } from "./api";
import { element } from "./dom";
const form = element<HTMLFormElement>("#login-form");
form.onsubmit = async (event) => {
  event.preventDefault();
  const button = element<HTMLButtonElement>("button", form);
  const error = element("#login-error");
  button.disabled = true;
  error.hidden = true;
  try {
    await request("/api/auth/login", "POST", {
      token: element<HTMLInputElement>('[name="token"]', form).value
    });
    location.assign("/");
  } catch {
    error.textContent =
      "Could not sign in. Check your admin token and try again.";
    error.hidden = false;
    button.disabled = false;
  }
};
