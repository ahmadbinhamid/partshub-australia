import axios from "axios";
import { clearCartStorage } from "@/context/cart";
import { clearOrderDraft } from "@/lib/orderDraftStorage";

const TOKEN_KEY = "auth_token";

export const getToken   = ()           => localStorage.getItem(TOKEN_KEY);
export const setToken   = (t: string)  => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = ()           => localStorage.removeItem(TOKEN_KEY);

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? "http://localhost:7000/api/v1",
  headers: { "Content-Type": "application/json" },
  timeout: 15_000,
});

apiClient.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

apiClient.interceptors.response.use(
  (res) => res,
  async (err) => {
    // A request made with responseType: "blob" (e.g. downloading a PDF) still
    // gets its ERROR body parsed as a Blob, not JSON — recover the real
    // message so a failed download doesn't just say "Request failed with
    // status code 404" instead of the backend's actual error message.
    if (err.response?.data instanceof Blob && err.response.data.type?.includes("json")) {
      try {
        err.response.data = JSON.parse(await err.response.data.text());
      } catch {
        /* wasn't actually JSON — leave as-is */
      }
    }

    const status: number | undefined = err.response?.status;
    const message: string =
      err.response?.data?.message ?? err.message ?? "Something went wrong";

    if (status === 401) {
      clearToken();
      clearCartStorage();
      clearOrderDraft();
      if (!window.location.pathname.startsWith("/login")) {
        window.location.replace("/login");
      }
    }

    const error = new Error(message) as Error & {
      status?: number;
      errors?: Array<{ field: string; message: string }>;
      reason?: string;
    };
    error.status = status;
    if (status === 422 && Array.isArray(err.response?.data?.errors)) {
      error.errors = err.response.data.errors;
    }
    // Some 400s carry a machine-readable `reason` alongside `message` (e.g.
    // google.controller.js#completeConnect's GCP_REGISTRATION_PENDING/
    // CONFLICT/MERCHANT_NOT_ACCESSIBLE cases) so a caller can show a
    // specific friendly message instead of just the raw error text.
    if (typeof err.response?.data?.reason === "string") {
      error.reason = err.response.data.reason;
    }
    return Promise.reject(error);
  },
);
