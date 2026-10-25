import { colors } from "@beehave/shared";
import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Modal, Pressable, Text, TextInput, View } from "react-native";
import { styles } from "../styles";

export function CalendarSheet({
  visible,
  date,
  onSelect,
  onClose,
}: {
  visible: boolean;
  date: string;
  onSelect: (date: string) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(
    () => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1),
  );
  const [manualDate, setManualDate] = useState(date);
  const [manualDateError, setManualDateError] = useState(false);
  useEffect(() => {
    if (visible) {
      setManualDate(date);
      setManualDateError(false);
      setMonth(
        new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1),
      );
    }
  }, [visible, date]);
  const year = month.getFullYear();
  const monthNumber = month.getMonth();
  const daysInMonth = new Date(year, monthNumber + 1, 0).getDate();
  const cells = Array.from(
    { length: Math.ceil((month.getDay() + daysInMonth) / 7) * 7 },
    (_, index) => {
      const day = index - month.getDay() + 1;
      return day > 0 && day <= daysInMonth ? day : null;
    },
  );
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <View style={styles.sheetBackdrop}>
        <Pressable
          style={styles.sheetDismiss}
          onPress={onClose}
          accessibilityLabel="Close calendar"
        />
        <View style={styles.sheet} accessibilityViewIsModal>
          <View style={styles.sheetHandle} />
          <View style={styles.row}>
            <Text style={styles.subtitle}>Choose a date</Text>
            <Pressable
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Close calendar"
              onPress={onClose}
            >
              <Feather name="x" size={20} color={colors.navy} />
            </Pressable>
          </View>
          <View style={styles.row}>
            <Pressable
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
              onPress={() => setMonth(new Date(year, monthNumber - 1, 1))}
            >
              <Feather name="chevron-left" size={20} color={colors.navy} />
            </Pressable>
            <Text style={styles.subtitle}>
              {month.toLocaleDateString("en", {
                month: "long",
                year: "numeric",
              })}
            </Text>
            <Pressable
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Next month"
              onPress={() => setMonth(new Date(year, monthNumber + 1, 1))}
            >
              <Feather name="chevron-right" size={20} color={colors.navy} />
            </Pressable>
          </View>
          <View style={styles.row}>
            <TextInput
              accessibilityLabel="Type a date as year-month-day"
              value={manualDate}
              onChangeText={(value) => {
                // The text is never rewritten while typing, so the cursor and deletions behave normally.
                setManualDate(value);
                setManualDateError(false);
                const typed = normalizeDate(value);
                if (isDate(typed))
                  setMonth(new Date(Number(typed.slice(0, 4)), Number(typed.slice(5, 7)) - 1, 1));
              }}
              onSubmitEditing={applyManualDate}
              placeholder="YYYY-MM-DD"
              keyboardType="numbers-and-punctuation"
              autoCorrect={false}
              autoComplete="off"
              textContentType="none"
              maxLength={10}
              returnKeyType="done"
              style={[styles.input, styles.grow]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Use typed date"
              style={[styles.button, styles.primary]}
              onPress={applyManualDate}
            >
              <Text style={styles.buttonText}>Go</Text>
            </Pressable>
          </View>
          {manualDateError && (
            <Text style={styles.error}>Enter a valid date as YYYY-MM-DD or YYYYMMDD.</Text>
          )}
          <View style={{ flexDirection: "row" }}>
            {["S", "M", "T", "W", "T", "F", "S"].map((label, index) => (
              <Text
                key={index}
                style={[
                  styles.caption,
                  { width: "14.2857%", textAlign: "center" },
                ]}
              >
                {label}
              </Text>
            ))}
          </View>
          <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
            {cells.map((day, index) => {
              const value = `${year}-${String(monthNumber + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
              return (
                <View key={index} style={{ width: "14.2857%", padding: 2 }}>
                  {day && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Choose ${value}`}
                      accessibilityState={{ selected: date === value }}
                      onPress={() => {
                        onSelect(value);
                        onClose();
                      }}
                      style={{
                        height: 44,
                        borderRadius: 12,
                        alignItems: "center",
                        justifyContent: "center",
                        backgroundColor:
                          date === value ? "#F2B544" : "transparent",
                      }}
                    >
                      <Text style={styles.body}>{day}</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );

  function applyManualDate() {
    const typed = normalizeDate(manualDate);
    if (!isDate(typed)) {
      setManualDateError(true);
      return;
    }
    onSelect(typed);
    onClose();
  }
}

// Accepts 20261024, 2026-10-24, 2026/10/24 or 2026.10.24 and returns YYYY-MM-DD.
function normalizeDate(value: string) {
  const digits = value.trim().replace(/[^0-9]/g, "");
  return digits.length === 8
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`
    : value.trim();
}

function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return (
    parsed.getFullYear() === year &&
    parsed.getMonth() === month - 1 &&
    parsed.getDate() === day
  );
}
