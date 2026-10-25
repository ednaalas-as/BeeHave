import { type Session } from "@beehave/shared";
import { useState } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { apiRequest } from "../api";
import { BrandLogo } from "../components/BrandLogo";
import { Button, Card, Field } from "../components/FormControls";
import { Wordmark } from "../components/Wordmark";
import { styles } from "../styles";

export function Login({
  onLogin,
  initialError,
}: {
  onLogin: (s: Session) => Promise<void>;
  initialError: string;
}) {
  const [register, setRegister] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  const [samplePreview, setSamplePreview] = useState(false);
  const [pending, setPending] = useState(false);
  async function submit(demo = false) {
    if (!demo && register && password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError("");
    try {
      const session = await apiRequest<Session>(
        `/auth/${demo ? "demo" : register ? "register" : "login"}`,
        {
          method: "POST",
          body: JSON.stringify({
            email,
            password,
            // The API creates the new account's own farm workspace automatically.
            ...(register && !demo ? { name } : {}),
            platform: "native",
          }),
        },
      );
      // Leave the sign-in screen with its password fields closed and empty, so the
      // system password prompt is not carried onto the dashboard.
      Keyboard.dismiss();
      setPassword("");
      setConfirmPassword("");
      await onLogin(session);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function recover() {
    setPending(true);
    setError("");
    setMessage("");
    try {
      await apiRequest("/auth/recover", {
        method: "POST",
        body: JSON.stringify({ email }),
      });
      setMessage(
        "If an account uses that email, a recovery link will be sent. Check your inbox and spam folder.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.login}
      >
        <View style={styles.loginBrand}>
          <BrandLogo size={74} />
          <Wordmark width={205} />
          <Text style={styles.loginDescription}>Bee activity monitoring</Text>
        </View>
        <Card>
          <Text style={styles.subtitle}>
            {recovering
              ? "Recover your account"
              : register
                ? "Create an account"
                : "Sign in"}
          </Text>
          {!recovering && register && (
            <Field
              label="Full name"
              value={name}
              onChange={setName}
              account="name"
            />
          )}
          <Field
            label="Email"
            value={email}
            onChange={setEmail}
            account="email"
          />
          {!recovering && (
            <Field
              label={
                register ? "Password (at least 12 characters)" : "Password"
              }
              value={password}
              onChange={setPassword}
              secure
              account={register ? "newPassword" : "password"}
            />
          )}
          {!recovering && register && (
            <Field
              label="Confirm password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              secure
              account="newPassword"
            />
          )}
          {!!error && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {!!message && <Text style={styles.body}>{message}</Text>}
          <Button
            title={
              pending
                ? "Please wait…"
                : recovering
                  ? "Send recovery email"
                  : register
                    ? "Create account"
                    : "Sign in"
            }
            onPress={() => (recovering ? recover() : submit())}
            disabled={pending}
            primary
          />
          {recovering ? (
            <Pressable
              style={styles.textButton}
              accessibilityRole="button"
              onPress={() => {
                setRecovering(false);
                setError("");
                setMessage("");
              }}
            >
              <Text style={styles.link}>Back to sign in</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                style={styles.textButton}
                accessibilityRole="button"
                onPress={() => {
                  setRegister(!register);
                  setConfirmPassword("");
                  setError("");
                }}
              >
                <Text style={styles.link}>
                  {register
                    ? "Already registered? Sign in"
                    : "Create an account"}
                </Text>
              </Pressable>
              {!register && (
                <Pressable
                  style={styles.textButton}
                  accessibilityRole="button"
                  onPress={() => {
                    setRecovering(true);
                    setError("");
                    setMessage("");
                  }}
                >
                  <Text style={styles.caption}>Forgot password?</Text>
                </Pressable>
              )}
            </>
          )}
        </Card>
        {recovering ? null : samplePreview ? (
          <Card>
            <Text style={styles.subtitle} accessibilityRole="header">
              Sample Farm Preview
            </Text>
            <Text style={styles.body}>
              The data shown in this farm is synthetic and is provided only to
              demonstrate BeeHave’s features and how the application works. It
              does not represent actual bee activity, recordings, environmental
              readings, or real farm data.
            </Text>
            <Button
              title="Continue to Sample Farm"
              onPress={() => submit(true)}
              disabled={pending}
              primary
            />
            <Button
              title="Cancel"
              onPress={() => setSamplePreview(false)}
              disabled={pending}
            />
          </Card>
        ) : (
          <Button
            title="Explore sample farm"
            onPress={() => setSamplePreview(true)}
            disabled={pending}
          />
        )}
        <Text style={styles.caption}>
          Sample records are synthetic and separate from real farms.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
