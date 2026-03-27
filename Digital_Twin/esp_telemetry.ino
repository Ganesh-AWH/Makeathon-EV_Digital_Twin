/**
 * EV Digital Twin - ESP8266 / ESP32 Hardware Telemetry Sender
 * 
 * This sketch connects your ESP to WiFi and sends the data gathered from
 * your Arduino (Temp, Humidity, Heat Index) and ESP (Battery) mapped to 
 * the EV Digital Twin Flask server.
 * 
 * Required Libraries:
 * - ArduinoJson (by Benoit Blanchon) -> Install via Library Manager
 */

#if defined(ESP8266)
  #include <ESP8266WiFi.h>
  #include <ESP8266HTTPClient.h>
#else
  #include <WiFi.h>
  #include <HTTPClient.h>
#endif
#include <ArduinoJson.h>

// --- WiFi Credentials ---
const char* WIFI_SSID = "Vichu";
const char* WIFI_PASSWORD = "0987654321";

// --- Flask Server Address ---
// Enter the IP address of the computer running your Flask server
// e.g., "http://192.168.1.100:5000/ingest"
const char* SERVER_URL = "http://YOUR_COMPUTER_IP:5000/ingest";

// --- Timer ---
unsigned long lastPublish = 0;
const long publishInterval = 1000; // Send data every 1 second (1000ms)

void setup() {
  Serial.begin(115200);
  delay(100);
  
  // Connect to WiFi
  Serial.println("\nConnecting to WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("\nWiFi connected!");
  Serial.print("ESP IP Address: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  // Read from Arduino via Serial or other pins
  // (Assuming you have logic to parse temp, humidity, etc. from Arduino)
  
  if (millis() - lastPublish >= publishInterval) {
    lastPublish = millis();
    
    // --- 1. Gather Sensor Data ---
    // (Replace these with your actual sensor reading variables)
    float currentTemp = 42.5;       // Read from Arduino Temp Sensor
    float currentBattery = 88.0;    // Read from ESP Battery logic
    float currentHumidity = 60.0;   // Read from Arduino Humidity Sensor
    float currentHeatIndex = 45.0;  // Read from Arduino Heat Index computation
    
    // --- 2. Send Data to Flask Server ---
    sendTelemetry(currentTemp, currentBattery, currentHumidity, currentHeatIndex);
  }
}

void sendTelemetry(float temp, float battery, float hum, float heatIdx) {
  if (WiFi.status() == WL_CONNECTED) {
    WiFiClient client;
    HTTPClient http;
    
    // Start HTTP connection
    http.begin(client, SERVER_URL);
    http.addHeader("Content-Type", "application/json");

    // Build JSON payload
    StaticJsonDocument<200> doc;
    doc["temp"] = temp;
    doc["battery"] = battery;
    doc["humidity"] = hum;
    doc["heat_index"] = heatIdx;
    
    String jsonPayload;
    serializeJson(doc, jsonPayload);

    // Send POST request
    Serial.print("Sending Data: ");
    Serial.println(jsonPayload);
    
    int httpResponseCode = http.POST(jsonPayload);

    if (httpResponseCode > 0) {
      Serial.print("Server Response Code: ");
      Serial.println(httpResponseCode);
    } else {
      Serial.print("Error sending POST request: ");
      Serial.println(http.errorToString(httpResponseCode).c_str());
    }
    
    http.end(); // Free resources
  } else {
    Serial.println("WiFi Disconnected!");
  }
}
