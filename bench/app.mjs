// Deterministic shop app for the benchmark: sign in, search, add to cart,
// check out. All state lives in sessionStorage, so every new tab starts clean.

import { createServer } from "node:http";

const PRODUCTS = [
  "Mechanical Keyboard K2",
  "Mechanical Keyboard K8 Pro",
  "Low-profile Keyboard",
  "Wireless Mouse M3",
  "Vertical Mouse",
  "USB-C Hub 7-in-1",
  "27-inch Monitor",
  "Monitor Arm",
  "Laptop Stand",
  "Webcam 1080p",
  "Noise-cancelling Headphones",
  "Desk Mat XL",
  "Keyboard Wrist Rest",
  "Mouse Bungee",
  "Cable Organizer",
  "Desk Lamp",
];

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} — Bench Shop</title>
<style>
  body { font: 15px/1.5 sans-serif; margin: 0; }
  header { display: flex; gap: 16px; align-items: center; padding: 12px 24px; background: #222; color: #fff; }
  header a { color: #fff; }
  main { padding: 24px; max-width: 900px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 12px; }
  label { display: block; margin: 8px 0; }
  input[type=text], input[type=password], textarea { width: 280px; padding: 6px; }
  button { padding: 6px 14px; margin-top: 6px; }
</style></head>
<body>
<header><strong>Bench Shop</strong><nav><a href="/shop">Products</a> · <a href="/cart" id="cart-link">Cart (<span id="cart-count">0</span>)</a></nav></header>
<main>${body}</main>
<script>
  const cart = () => JSON.parse(sessionStorage.getItem("cart") || "[]");
  document.getElementById("cart-count").textContent = cart().length;
</script>
</body></html>`;

const pages = {
  "/login": () =>
    layout(
      "Sign in",
      `<h1>Sign in</h1>
      <form id="login">
        <label>Username <input type="text" name="user" autocomplete="off"></label>
        <label>Password <input type="password" name="pass"></label>
        <button type="submit">Sign in</button>
      </form>
      <p id="error" role="alert"></p>
      <script>
        document.getElementById("login").addEventListener("submit", (event) => {
          event.preventDefault();
          const data = new FormData(event.target);
          if (data.get("user") === "agent" && data.get("pass") === "hunter2") {
            sessionStorage.setItem("user", "agent");
            location.href = "/shop";
          } else {
            document.getElementById("error").textContent = "Wrong username or password";
          }
        });
      </script>`,
    ),
  "/shop": (url) => {
    const query = (url.searchParams.get("q") || "").toLowerCase();
    const items = PRODUCTS.filter((name) => name.toLowerCase().includes(query));
    return layout(
      "Products",
      `<h1>Products</h1>
      <form action="/shop" role="search"><label>Search <input type="text" name="q" value="${query}"></label></form>
      <p id="result-count">${items.length} results</p>
      <div class="grid">${items
        .map(
          (name, index) => `<div class="card"><h2 style="font-size:16px">${name}</h2>
          <p>$${(49 + index * 13).toFixed(2)}</p>
          <button type="button" aria-label="Add ${name} to cart" data-name="${name}">Add to cart</button></div>`,
        )
        .join("")}</div>
      <script>
        if (!sessionStorage.getItem("user")) location.href = "/login";
        for (const button of document.querySelectorAll("button[data-name]")) {
          button.addEventListener("click", () => {
            const next = [...cart(), button.dataset.name];
            sessionStorage.setItem("cart", JSON.stringify(next));
            document.getElementById("cart-count").textContent = next.length;
            button.textContent = "Added";
            button.disabled = true;
          });
        }
      </script>`,
    );
  },
  "/cart": () =>
    layout(
      "Cart",
      `<h1>Your cart</h1><ul id="items"></ul>
      <a href="/checkout" id="checkout">Checkout</a>
      <script>
        for (const name of cart()) {
          const li = document.createElement("li");
          li.textContent = name;
          document.getElementById("items").append(li);
        }
      </script>`,
    ),
  "/checkout": () =>
    layout(
      "Checkout",
      `<h1>Checkout</h1>
      <form id="checkout-form">
        <label>Full name <input type="text" name="name"></label>
        <label>Address <textarea name="address" rows="2"></textarea></label>
        <fieldset><legend>Shipping</legend>
          <label><input type="radio" name="shipping" value="standard" checked> Standard</label>
          <label><input type="radio" name="shipping" value="express"> Express</label>
        </fieldset>
        <label><input type="checkbox" name="agree"> I agree to the terms</label>
        <button type="submit">Place order</button>
      </form>
      <p id="error" role="alert"></p>
      <script>
        document.getElementById("checkout-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const data = new FormData(event.target);
          if (!data.get("name") || !data.get("address") || !data.get("agree")) {
            document.getElementById("error").textContent = "Please complete the form";
            return;
          }
          const order = { items: cart(), name: data.get("name"), shipping: data.get("shipping") };
          sessionStorage.setItem("order", JSON.stringify(order));
          location.href = "/done";
        });
      </script>`,
    ),
  "/done": () =>
    layout(
      "Order placed",
      `<h1>Thank you!</h1><p id="summary"></p>
      <script>
        const order = JSON.parse(sessionStorage.getItem("order") || "null");
        document.getElementById("summary").textContent = order
          ? "Order ORD-" + (1000 + order.items.length * 42) + " for " + order.name + ": " +
            order.items.join(", ") + " (" + order.shipping + ")"
          : "No order";
      </script>`,
    ),
};

export const EXPECTED_SUMMARY = "Order ORD-1042 for Ada Lovelace: Mechanical Keyboard K2 (express)";

export function startApp() {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    const page = pages[url.pathname];
    if (!page) {
      response.writeHead(302, { location: "/login" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(url));
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` })),
  );
}
