// mariowOS Backend (kernel/server.js) - (C) 2025 mariowstech and the mariowOS team 
// Licensed under the Apache License, Version 2.0; you can use this file if you give credits to the original creators and you may not use this file except in compliance with the License. 
// Obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. 
// This project use open source and free fonts sourced from Google Fonts. Google Fonts is a trademark of Google LCC, privacy docs are at https://developers.google.com/fonts/faq/privacy 

const cron = require('node-cron');


const nodemailer = require("nodemailer");
const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: "confirmation.mariowos@gmail.com", //da creare
    pass: "eapv psur ruuk yrrf" // app password, da inserire
  },
  tls: {
    rejectUnauthorized: false
  }
});


const app = express();
const PORT = 3000;

const multer = require("multer");

const os = require("os");

// multer configuration for avatar upload
const avatarStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, "desktop/assets")),
  filename: (req, file, cb) => cb(null, "avatar.user.png")
});
const avatarUpload = multer({ storage: avatarStorage, fileFilter: (req, file, cb) => {
  if (file.mimetype === "image/png" || file.mimetype === "image/jpeg") {
    cb(null, true);
  } else {
    cb(new Error("Only PNG and JPG files are allowed!"), false);
  }
}});

// middleware to parse POST data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
// If settings already exist, redirect direct requests for the editor page to the confirmation page
app.get('/desktop/apps/settings/assets/you.html', (req, res, next) => {
  try {
    if (config && config.username && config.email) {
      return res.redirect('/desktop/apps/settings/assets/youafter.html');
    }
  } catch (e) {
    // ignore and fall through to static
  }
  next();
});

// serve static folders
app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

// load or initialize password configuration file 
let config = { passwordHash: null };
const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}

// Keep a reference to the scheduled daily email task so it can be rescheduled cleanly
let dailyEmailTask = null;

async function sendDiscordFlagsEmail() {
  if (!config.email) return;

  try {
    const mailOptions = {
      from: {
        name: "mariowOS",
        address: "confirmation.mariowos@gmail.com",
      },
      to: config.email,
      subject: "mariowOS Daily Issue Flags - Discord",
      html: `
<div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 40px 0;">
  <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
    <tr>
      <td align="center" style="padding-bottom: 20px;">
        <h2 style="margin: 0; color: #2c3e50;">mariowOS</h2>
        <p style="margin: 5px 0 0; color: #7f8c8d; font-size: 14px;">Daily Issue Flags Update</p>
      </td> 
    </tr>
    <tr>
      <td style="color: #2c3e50; font-size: 16px;">
        Hello <strong>${config.username || 'User'}</strong>,
      </td>
    </tr>
    <tr>
      <td style="padding: 20px 0; color: #555; font-size: 15px;">
        Check the latest issue flags and problems on our Discord server:
      </td>
    </tr>
    <tr>
      <td align="center" style="padding: 20px 0;">
        <a href="https://discord.gg/placeholder-issueflags" style="background: #5865F2; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px;">Join Discord Flags Channel</a>
      </td>
    </tr>
    <tr>
      <td style="padding-top: 25px; color: #7f8c8d; font-size: 14px;">
        This is an automated daily report. You can disable it anytime in Preferences.
      </td>
    </tr>
    <tr>
      <td style="padding-top: 30px; color: #bdc3c7; font-size: 12px;" align="center">
        © ${new Date().getFullYear()} mariowOS
      </td>
    </tr>
  </table>
</div>`
    };

    await transporter.sendMail(mailOptions);
    console.log('Daily Discord flags email sent to', config.email);

    config.lastSent = Date.now();
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  } catch (err) {
    console.error('Failed to send daily email:', err);
  }
}

// serve OOBE if no password, else login screen
app.get("/", (req, res) => {
  if (!config.passwordHash) {
    res.sendFile(path.join(__dirname, "desktop/welcome.html"));
  } else {
    res.sendFile(path.join(__dirname, "loginui/com.mariowos.loginui.html"));
  }
});

// POST route to set password (from OOBE page)
app.post("/set-password", async (req, res) => {
  const { username, newPassword } = req.body;
  if (!newPassword) return res.send("❌ No password provided!");
  if (!username) return res.send("❌ No username provided!");

  try {
    const hash = await bcrypt.hash(newPassword, 10);
    config.username = username;
    config.passwordHash = hash;
    fs.writeFileSync(configFile, JSON.stringify(config));
    res.send("✅ Password and username updated!");
  } catch (err) {
    res.status(500).send("❌ Error setting password");
  }
});

// POST route to save user settings (with email verification)
app.post("/save-settings", async (req, res) => {
  const { username, email, language, theme } = req.body;

  if (!username || !email) {
    return res.status(400).json({ success: false, error: "Username and email required" });
  }

  try {
    // Generate 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

    // Store temporarily (do not save permanent settings yet)
    config.tempUsername = username;
    config.tempEmail = email;
    config.tempLanguage = language;
    config.tempTheme = theme;
    config.verificationCode = verificationCode;
    config.codeExpiresAt = codeExpiresAt;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    // Contenuto della mail with code
    const mailOptions = {
  from: {
    name: "mariowOS",
    address: process.env.MAIL_USER,
  },
  to: email,
  subject: "mariowOS - Verification code",
  text: `Hello ${username}, your verification code is: ${verificationCode}`,
  html: `
  <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 40px 0;">
    <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
      
      <tr>
        <td align="center" style="padding-bottom: 20px;">
          <h2 style="margin: 0; color: #2c3e50;">mariowOS</h2>
          <p style="margin: 5px 0 0; color: #7f8c8d; font-size: 14px;">
            Account verification
          </p>
        </td>
      </tr>

      <tr>
        <td style="color: #2c3e50; font-size: 16px;">
          Hello <strong>${username}</strong>,
        </td>
      </tr>

      <tr>
        <td style="padding: 20px 0; color: #555; font-size: 15px;">
          Use the following verification code to complete your setup:
        </td>
      </tr>

      <tr>
        <td align="center">
          <div style="
            display: inline-block;
            background: #f1f3f5;
            color: #2c3e50;
            font-size: 28px;
            font-weight: bold;
            letter-spacing: 4px;
            padding: 15px 25px;
            border-radius: 8px;
          ">
            ${verificationCode}
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding-top: 25px; color: #7f8c8d; font-size: 14px;">
          This code will expire shortly. If you didn’t request it, you can ignore this email.
        </td>
      </tr>

      <tr>
        <td style="padding-top: 30px; color: #bdc3c7; font-size: 12px;" align="center">
          © ${new Date().getFullYear()} mariowOS
        </td>
      </tr>

    </table>
  </div>
  `,
};

    await transporter.sendMail(mailOptions);
    console.log("Mail sent to:", email, "with code:", verificationCode);

    res.json({ success: true, message: "Verification code sent via email!" });

  } catch (err) {
    console.error("E:", err);
    res.status(500).json({ success: false, error: "Error sending email, is it right?" });
  }
});

// POST route to verify code
app.post("/verify-code", async (req, res) => {
  const { code } = req.body;

  if (!code) {
    return res.status(400).json({ success: false, error: "Code required" });
  }

  try {
    if (!config.verificationCode || !config.codeExpiresAt) {
      return res.status(400).json({ success: false, error: "No verification code active" });
    }

    if (Date.now() > config.codeExpiresAt) {
      // Clear expired code
      delete config.verificationCode;
      delete config.codeExpiresAt;
      delete config.tempUsername;
      delete config.tempEmail;
      delete config.tempLanguage;
      delete config.tempTheme;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
      return res.status(400).json({ success: false, error: "Expired code" });
    }

    if (code !== config.verificationCode) {
      return res.status(400).json({ success: false, error: "Unvalid code" });
    }

    // Code is valid, save settings permanently
    config.username = config.tempUsername;
    config.email = config.tempEmail;
    config.language = config.tempLanguage;
    config.theme = config.tempTheme;
    config.verified = true;

    // Enable daily reports by default when user verifies email
    if (typeof config.sendReports !== 'boolean') {
      config.sendReports = true;
    }

    // Clear temporary data
    delete config.verificationCode;
    delete config.codeExpiresAt;
    delete config.tempUsername;
    delete config.tempEmail;
    delete config.tempLanguage;
    delete config.tempTheme;

    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    // Send the first report immediately, then schedule daily
    await sendDiscordFlagsEmail();
    scheduleDailyEmail();

    res.json({ success: true, message: "Settings verified and saved!" });

  } catch (err) {
    console.error("Error verifying code:", err);
    res.status(500).json({ success: false, error: "Error verifying code" });
  }
});

// Route per conferma email
app.get("/confirm", (req, res) => {
  res.send("<h2>Email confirmed! Thank you for confirming your mariowOS account.</h2>");
});

// Fallback GET for easier debugging: return JSON instead of HTML for non-POST requests
app.get("/save-settings", (req, res) => {
  res.json({ success: false, error: "Use POST to save settings" });
});

// GET route to return current settings (hide passwordHash)
app.get('/get-settings', (req, res) => {
  try {
    const safe = Object.assign({}, config);
    if (safe.passwordHash) delete safe.passwordHash;
    res.json(safe);
  } catch (err) {
    res.status(500).json({});
  }
});

// POST route for forgot password - send reset code via email
app.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, error: "Email is required" });
  }

  // Reload config to ensure it's up to date
  let currentConfig = { passwordHash: null, email: null };
  if (fs.existsSync(configFile)) {
    currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }

  // Check if the email matches the one in config
  if (!currentConfig.email || currentConfig.email !== email) {
    return res.status(400).json({ success: false, error: "Email not found in our records" });
  }

  try {
    // Generate 6-digit reset code
    const resetCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeExpiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes

    // Store the reset code temporarily
    currentConfig.resetCode = resetCode;
    currentConfig.resetCodeExpiresAt = codeExpiresAt;
    fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));

    // Send email with reset code
    const mailOptions = {
  from: {
    name: "mariowOS",
    address: process.env.MAIL_USER,
  },
  to: email,
  subject: "mariowOS - Verification code",
  text: `Hello ${username}, your verification code is: ${verificationCode}`,
  html: `
  <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 40px 0;">
    <table align="center" width="100%" cellpadding="0" cellspacing="0" style="max-width: 500px; background: #ffffff; border-radius: 10px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
      
      <tr>s
        <td align="center" style="padding-bottom: 20px;">
          <h2 style="margin: 0; color: #2c3e50;">mariowOS</h2>
          <p style="margin: 5px 0 0; color: #7f8c8d; font-size: 14px;">
            Account verification
          </p>
        </td> 
      </tr>

      <tr>
        <td style="color: #2c3e50; font-size: 16px;">
          Hello <strong>${username}</strong>,
        </td>
      </tr>

      <tr>
        <td style="padding: 20px 0; color: #555; font-size: 15px;">
          Use the following verification code to complete your setup:
        </td>
      </tr>

      <tr>
        <td align="center">
          <div style="
            display: inline-block;
            background: #f1f3f5;
            color: #2c3e50;
            font-size: 28px;
            font-weight: bold;
            letter-spacing: 4px;
            padding: 15px 25px;
            border-radius: 8px;
          ">
            ${verificationCode}
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding-top: 25px; color: #7f8c8d; font-size: 14px;">
          This code will expire shortly. If you didn’t request it, you can ignore this email.
        </td>
      </tr>

      <tr>
        <td style="padding-top: 30px; color: #bdc3c7; font-size: 12px;" align="center">
          © ${new Date().getFullYear()} mariowOS
        </td>
      </tr>

    </table>
  </div>
  `,
};

    await transporter.sendMail(mailOptions);
    console.log("Password reset code sent to:", email, "with code:", resetCode);

    res.json({ success: true, message: "Reset code sent to your email!" });

  } catch (err) {
    console.error("Error sending reset email:", err);
    res.status(500).json({ success: false, error: "Error sending email" });
  }
});

// POST route to reset password with code verification
app.post("/reset-password", async (req, res) => {
  const { email, code, newPassword } = req.body;

  if (!email || !code || !newPassword) {
    return res.status(400).json({ success: false, error: "Email, code, and new password are required" });
  }

  // Reload config to ensure it's up to date
  let currentConfig = { passwordHash: null, email: null };
  if (fs.existsSync(configFile)) {
    currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }

  // Check if email matches
  if (!currentConfig.email || currentConfig.email !== email) {
    return res.status(400).json({ success: false, error: "Invalid email" });
  }

  // Check if reset code exists and is valid
  if (!currentConfig.resetCode || !currentConfig.resetCodeExpiresAt) {
    return res.status(400).json({ success: false, error: "No reset code active. Please request a new one." });
  }

  // Check if code has expired
  if (Date.now() > currentConfig.resetCodeExpiresAt) {
    // Clear expired code
    delete currentConfig.resetCode;
    delete currentConfig.resetCodeExpiresAt;
    fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));
    return res.status(400).json({ success: false, error: "Reset code has expired. Please request a new one." });
  }

  // Verify the code
  if (code !== currentConfig.resetCode) {
    return res.status(400).json({ success: false, error: "Invalid reset code" });
  }

  try {
    // Hash the new password
    const hash = await bcrypt.hash(newPassword, 10);
    currentConfig.passwordHash = hash;

    // Clear reset code
    delete currentConfig.resetCode;
    delete currentConfig.resetCodeExpiresAt;

    fs.writeFileSync(configFile, JSON.stringify(currentConfig, null, 2));

    console.log("Password reset successful for:", email);
    res.json({ success: true, message: "Password reset successful!" });

  } catch (err) {
    console.error("Error resetting password:", err);
    res.status(500).json({ success: false, error: "Error resetting password" });
  }
});

// route to verify password (from lockscreen)
app.post("/login", async (req, res) => {
  const {password } = req.body;
  console.log("Login attempt:", {password });

  // Reload config to ensure it's up to date
  let currentConfig = { passwordHash: null };
  if (fs.existsSync(configFile)) {
    currentConfig = JSON.parse(fs.readFileSync(configFile, "utf8"));
  }
  console.log("currentConfig.passwordHash exists:", !!currentConfig.passwordHash);

  if (!currentConfig.passwordHash) {
    console.log("No username or password set in config");
    return res.send("❌ No username or password set!");
  }

const match = await bcrypt.compare(password, currentConfig.passwordHash);
  console.log("Password match:", match);
  if (match) {
    console.log("Login successful, sending desktop");
    res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
  } else {
    console.log("Wrong password");
    res.send("❌ Wrong password!");
  }
});

// serve desktop HTML directly (only for internal links)
app.get("/desktop/com.mariowos.desktop.html", (req, res) => {
  res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
});

// keyring host commands
const keysFile = path.join(__dirname, "keys.json");

app.post("/save-key", express.json(), (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).send("[KEYRING] E: No key provided!");

  let keys = [];
  if (fs.existsSync(keysFile)) {
    try {
      keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    } catch (e) {
      keys = [];
    }
  }

  keys.push({ key, date: new Date().toISOString() });
  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));

  res.send(`[KEYRING] Key "${key}" saved to keyring!`);
});

// list all keys
app.get("/list-keys", (req, res) => {
  if (!fs.existsSync(keysFile)) return res.json([]);
  try {
    const keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
    res.json(keys);
  } catch (err) {
    res.status(500).json([]);
  }
});

// delete a key
app.post("/delete-key", express.json(), (req, res) => {
  const { key } = req.body;
  if (!key) return res.status(400).send("[KEYRING] E: No key specified!");

  if (!fs.existsSync(keysFile)) return res.send("[KEYRING] E: No keys found!");

  let keys = [];
  try {
    keys = JSON.parse(fs.readFileSync(keysFile, "utf8"));
  } catch (e) {
    return res.send("[KEYRING] E: Key file corrupted.");
  }

  const originalLength = keys.length;
  keys = keys.filter((k) => k.key !== key);

  if (keys.length === originalLength) {
    return res.send(`[KEYRING] E: Key "${key}" not found.`);
  }

  fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
  res.send(`[KEYRING] Key "${key}" deleted from keyring.`);
});

app.get("/sysinfo", (req, res) => {
  try {
    const cpus = os.cpus();
    const sysInfo = {
      OS: "mariowOS v0.9",
      Kernel: os.type() + " " + os.release(),
      Uptime: os.uptime(), // seconds
      CPU: `${cpus[0].model} (${cpus.length} cores)`,
      RAM: `${Math.round(os.totalmem() / 1024 / 1024)} MB`,
      FreeRAM: `${Math.round(os.freemem() / 1024 / 1024)} MB`,
    };
    res.json(sysInfo);
  } catch (err) {
    res.status(500).json({ error: "Failed to get system info" });
  }
});



// POST route to clear user settings (keep passwordHash)
app.post('/clear-settings', (req, res) => {
  try {
    if (config) {
      delete config.username;
      delete config.email;
      delete config.language;
      delete config.theme;
      delete config.verified;
      // Also clear any temporary verification data
      delete config.tempUsername;
      delete config.tempEmail;
      delete config.tempLanguage;
      delete config.tempTheme;
      delete config.verificationCode;
      delete config.codeExpiresAt;
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
    res.json({ success: true, message: 'Settings cleared' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Error clearing settings' });
  }
});

// FACTORY RESET ENDPOINT - Reset everything to original state
app.post("/api/system/factory-reset", express.json(), (req, res) => {
  try {
    console.log("[FACTORY RESET] Starting reset process...");
    
    // Reset config.json completely - passwordHash = null for fresh OOBE
    const originalConfig = { passwordHash: null };
    fs.writeFileSync(configFile, JSON.stringify(originalConfig, null, 2));
    
    // UPDATE IN-MEMORY CONFIG IMMEDIATELY
    config = originalConfig;
    console.log("[FACTORY RESET] Config updated in memory to:", config);
    
    // Clear keys.json completely
    fs.writeFileSync(keysFile, JSON.stringify([], null, 2));
    console.log("[FACTORY RESET] Keys.json cleared");
    console.log("[FACTORY RESET] All data has been cleared. passwordHash is now:", config.passwordHash);
    
    // Success response
    res.json({ success: true, message: "System has been fully reset to factory defaults", config: config });
  } catch (err) {
    console.error("[FACTORY RESET] Error:", err);
    res.status(500).json({ success: false, error: "Error during factory reset: " + err.message });
  }
});

// Preferences API endpoints
app.get('/api/preferences', (req, res) => {
  res.json({ sendReports: !!config.sendReports });
});

app.post('/api/preferences', express.json(), (req, res) => {
  const { sendReports } = req.body;
  if (typeof sendReports !== 'boolean') {
    return res.status(400).json({ error: 'sendReports must be boolean' });
  }
  config.sendReports = sendReports;
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  res.json({ success: true, sendReports });

  // (Re)schedule cron if needed
  scheduleDailyEmail();
});

function scheduleDailyEmail() {
  // Stop previous scheduled task so we don't double-schedule
  if (dailyEmailTask) {
    dailyEmailTask.stop();
    dailyEmailTask = null;
  }

  if (config.email && config.sendReports) {
    // Daily 09:00 Europe/Rome: '0 9 * * *'
    dailyEmailTask = cron.schedule('0 9 * * *', async () => {
      await sendDiscordFlagsEmail();
    }, { timezone: "Europe/Rome" });

    console.log('Daily Discord email cron scheduled');
  } else {
    console.log('Cron not scheduled: no email or reports disabled');
  }
}

// Initial schedule
scheduleDailyEmail();

app.listen(PORT, () => {
  console.log(`mariowOS is running at http://localhost:${PORT}`);
});

// POST route to save reports preference
app.post("/save-reports-preference", (req, res) => {
  const { sendReports } = req.body;

  if (typeof sendReports !== 'boolean') {
    return res.status(400).json({ success: false, error: "sendReports must be boolean" });
  }

  try {
    config.sendReports = sendReports;
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

    // Reschedule the cron job
    scheduleDailyEmail();

    res.json({ success: true, message: "Reports preference saved!" });
  } catch (err) {
    console.error("Error saving reports preference:", err);
    res.status(500).json({ success: false, error: "Error saving preference" });
  }
});

app.get("/clear-password", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config));
  res.send("config.js cleared. you can now exit fallback mode (finder > exit fallback mode) ");
});

// handler for wallpaper upload
const uploadDir = path.join(__dirname, "desktop", "assets");


// storage configuration (using multer)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname,"desktop/assets")),
  filename: (req, file, cb) => cb(null, "wallpaper.user.png") // qui salvato sempre come user wallpaper
});
const upload = multer({ storage, fileFilter: (req,file,cb)=> file.mimetype === "image/png" ? cb(null,true) : cb(new Error("Only PNG!")) });




// file filter to accept only PNG and JPG files
const fileFilter = (req, file, cb) => {
  // Lista dei MIME type consentiti
  const allowedTypes = ["image/png", "image/jpeg"];

  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true); // accetta il file
  } else {
    cb(new Error("Only PNG and JPG files are allowed!"), false); // rifiuta il file
  }
};





// actually upload the wallpaper
app.post("/upload-wallpaper", upload.single("wallpaper"), (req, res) => {
  res.send("Wallpaper updated successfully!");
});

// POST route to upload avatar
app.post("/upload-avatar", avatarUpload.single("avatar"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No avatar file provided" });
  }
  res.json({ success: true, message: "Avatar uploaded successfully!" });
});

// POST route to reset avatar to default
app.post("/reset-avatar", (req, res) => {
  try {
    const avatarPath = path.join(__dirname, "desktop/assets/avatar.user.png");
    if (fs.existsSync(avatarPath)) {
      fs.unlinkSync(avatarPath);
    }
    res.json({ success: true, message: "Avatar reset to default!" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Error resetting avatar" });
  }
});
