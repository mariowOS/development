const express = require("express");
const bodyParser = require("body-parser");
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const app = express();
const PORT = 3000;
const https = require("https");

// middleware to parse POST data
app.use(bodyParser.urlencoded({ extended: true }));

app.use("/desktop", express.static(path.join(__dirname, "desktop")));
app.use("/loginui", express.static(path.join(__dirname, "loginui")));

// load or initialize password config
let config = { passwordHash: null };
const configFile = path.join(__dirname, "config.json");
if (fs.existsSync(configFile)) {
  config = JSON.parse(fs.readFileSync(configFile, "utf8"));
}

// serve OOBE if no password detected, else login screen
app.get("/", (req, res) => {
  if (!config.passwordHash) {
    res.sendFile(path.join(__dirname, "desktop/welcome.html"));
  } else {
    res.sendFile(path.join(__dirname, "loginui/com.mariowos.loginui.html"));
  }
});

// POST route to set password (from password.html)
app.post("/set-password", async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.send("no password provided!");

  try {
    const hash = await bcrypt.hash(newPassword, 10);
    config.passwordHash = hash;
    fs.writeFileSync(configFile, JSON.stringify(config));
    res.send("password succesfully updated!");
  } catch (err) {
    res.status(500).send("error setting password");
  }
});

// POST route to verify password (from lockscreen only)
app.post("/login", async (req, res) => {
  const { password } = req.body;
  if (!config.passwordHash) return res.send("no password set!");

  const match = await bcrypt.compare(password, config.passwordHash);
  if (match) {
    res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
  } else {
    res.send("wrong password!");
  }
});

// !! optional !!
// serve desktop HTML directly (only for internal links)
app.get("/desktop/com.mariowos.desktop.html", (req, res) => {
  res.sendFile(path.join(__dirname, "desktop/com.mariowos.desktop.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

// testing only
app.get("/clear-password", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config));
  res.send("password cleared! you can now access OOBE again. http://localhost:3000");
});

// handle wallpaper change
const uploadDir = path.join(__dirname, "desktop", "assets");
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => cb(null, "wallpaper.png"), // always rename, too lazy to actually make it rewrite html file for name/extension tollerance
});
const fileFilter = (req, file, cb) => {
  if (file.mimetype === "image/png") cb(null, true);
  else cb(new Error("only .png files are allowed!"));
};

const upload = multer({ storage, fileFilter });

// wallpaper upload handler
app.post("/upload-wallpaper", upload.single("wallpaper"), (req, res) => {
  res.send("wallpaper updated successfully!");
});

// reset


app.get("/system-reset", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
      <style>
        body {
          background: #0b0b0b;
          color: white;
          display: flex;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          height: 100vh;
          font-family: 'Poppins', sans-serif;
          overflow: hidden;
        }
        .fade-in {
          animation: fadeIn 0.8s ease-in-out forwards;
        }
        .fade-out {
          animation: fadeOut 0.8s ease-in-out forwards;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
        @keyframes fadeOut {
          from { opacity: 1; transform: scale(1); }
          to { opacity: 0; transform: scale(1.05); }
        }
        .loader {
          border: 4px solid rgba(255, 255, 255, 0.1);
          border-left-color: white;
          border-radius: 50%;
          width: 48px;
          height: 48px;
          animation: spin 1s linear infinite;
          margin-top: 24px;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
    </head>
    <body class="fade-in">
      <h1>Restoring system...</h1>
      <div class="loader"></div>
      <script>
        setTimeout(() => {
          document.body.classList.add('fade-out');
          setTimeout(() => {
            window.location.href = '/__reset-now';
          }, 800);
        }, 1500);
      </script>
    </body>
    </html>
  `);
});

// internal route to perform the actual reset
app.get("/__reset-now", (req, res) => {
  config.passwordHash = null;
  fs.writeFileSync(configFile, JSON.stringify(config));

  const wallpaperUrl = "https://raw.githubusercontent.com/mariowstech/mariowOS-landpages/main/reset/wallpaper.png";
  const localPath = path.join(__dirname, "desktop", "assets", "wallpaper.png");
  const file = fs.createWriteStream(localPath);

  https.get(wallpaperUrl, (response) => {
    response.pipe(file);
    file.on("finish", () => {
      file.close();
      console.log("system restored!");
      setTimeout(() => res.redirect("/"), 500);
    });
  }).on("error", (err) => {
    console.error("restore error:", err);
    res.status(500).send("failed to restore system.");
  });
});
