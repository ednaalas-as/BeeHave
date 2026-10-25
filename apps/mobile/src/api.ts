import { createApi } from "@beehave/shared";
import * as SecureStore from "expo-secure-store";
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";
const STORAGE_KEY = "beehave.session";
let sessionToken: string | null = null;
export const getSessionToken = () => sessionToken;
export const apiRequest = createApi(API_BASE_URL, getSessionToken);
export async function restoreSessionToken() {
  sessionToken = await SecureStore.getItemAsync(STORAGE_KEY);
  return sessionToken;
}
export async function saveSessionToken(token: string) {
  await SecureStore.setItemAsync(STORAGE_KEY, token);
  sessionToken = token;
}
export async function clearSessionToken() {
  sessionToken = null;
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}
