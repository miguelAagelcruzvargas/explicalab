const whiteboard = document.getElementById("whiteboard");
const boardContext = whiteboard.getContext("2d");
const boardColorInput = document.getElementById("board-color");
const boardSizeInput = document.getElementById("board-size");
const clearBoardButton = document.getElementById("clear-board");
const landingUserNameInput = document.getElementById("landing-user-name");
const landingRoomIdInput = document.getElementById("landing-room-id");
const landingJoinRoomButton = document.getElementById("landing-join-room");
const copyRoomLinkButton = document.getElementById("copy-room-link");
const toggleAudioButton = document.getElementById("toggle-audio");
const roomStatus = document.getElementById("room-status");
const connectionBadge = document.getElementById("connection-badge");
const workspaceRole = document.getElementById("workspace-role");
const audioState = document.getElementById("audio-state");
const audioStatus = document.getElementById("audio-status");
const remoteAudio = document.getElementById("remote-audio");
const chatState = document.getElementById("chat-state");
const chatFeed = document.getElementById("chat-feed");
const chatEmpty = document.getElementById("chat-empty");
const chatInput = document.getElementById("chat-input");
const sendChatButton = document.getElementById("send-chat");
const assistantMode = document.getElementById("assistant-mode");
const assistantStatus = document.getElementById("assistant-status");
const assistantTitle = document.getElementById("assistant-title");
const assistantBody = document.getElementById("assistant-body");
const quickAiButtons = document.querySelectorAll(".quick-ai");
const teacherRequestInput = document.getElementById("teacher-request");
const exerciseTitleInput = document.getElementById("exercise-title");
const exercisePromptInput = document.getElementById("exercise-prompt");
const exerciseAnswerInput = document.getElementById("exercise-answer");
const syncExerciseButton = document.getElementById("sync-exercise");
const clearExerciseButton = document.getElementById("clear-exercise");

const socket = io();
const rtcConfig = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" }
  ]
};

let joinedRoom = false;
let currentRoomId = "";
let localParticipantId = "";
let currentUserRole = "";
let localStream = null;
let peerConnection = null;
let remoteParticipantId = "";
let audioEnabled = false;
let isDrawing = false;
let lastPoint = null;
let boardSyncTimeout = null;
let lastBoardDataUrl = "";
let resizeTimer = null;
let chatCount = 0;

const superscriptMap = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻"
};

function createRoomId() {
  return `clase-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(message, isConnected = false) {
  roomStatus.textContent = message;
  connectionBadge.textContent = isConnected ? "Conectado" : "Desconectado";
  connectionBadge.classList.toggle("connected", isConnected);
}

function setAudioUi(message, enabled = false) {
  audioStatus.textContent = message;
  audioState.textContent = enabled ? "Micro activo" : "Micro apagado";
  audioState.classList.toggle("connected", enabled);
  toggleAudioButton.textContent = enabled ? "Silenciar micro" : "Activar micro";
}

function updateChatState() {
  chatState.textContent = chatCount > 0 ? `${chatCount} mensaje${chatCount === 1 ? "" : "s"}` : "Sin mensajes";
}

function appendChatMessage(userName, message, isOwnMessage = false) {
  const trimmedMessage = String(message || "").trim();
  if (!trimmedMessage) {
    return;
  }

  chatCount += 1;
  updateChatState();
  chatEmpty.hidden = true;

  const article = document.createElement("article");
  article.className = `chat-message${isOwnMessage ? " own" : ""}`;
  article.innerHTML = `
    <p class="chat-author">${escapeHtml(userName || "Clase")}</p>
    <p class="chat-text">${renderMathHtml(trimmedMessage)}</p>
  `;
  chatFeed.appendChild(article);
  chatFeed.scrollTop = chatFeed.scrollHeight;
}

function escapeHtml(text = "") {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  };

  return text.replace(/[&<>"']/g, (char) => map[char]);
}

function formatMathText(text = "") {
  return text
    .replace(/\^(-?\d+)/g, (_match, exponent) => exponent.split("").map((char) => superscriptMap[char] || char).join(""))
    .replace(/([a-zA-Z)\]])(\d+)/g, (_match, base, exponent) => {
      const renderedExponent = exponent.split("").map((char) => superscriptMap[char] || char).join("");
      return `${base}${renderedExponent}`;
    })
    .replace(/\*/g, " × ");
}

function renderMathHtml(text = "") {
  return escapeHtml(formatMathText(text)).replace(/\n/g, "<br>");
}

function parseAssistantSections(text = "") {
  const cleaned = text.trim();
  if (!cleaned) {
    return [];
  }

  const normalized = cleaned.replace(/^\s*##\s*/gm, "");
  const matches = [...normalized.matchAll(/(^|\n)(EXPLICACION|EJERCICIO|PISTA|SOLUCION(?: PASO A PASO)?|RETROALIMENTACION|QUE HIZO BIEN|QUE DEBE CORREGIR|SIGUIENTE PASO|PASOS|CIERRE)\n/gi)];
  if (!matches.length) {
    return [{ heading: "Contenido", body: normalized }];
  }

  const sections = [];
  matches.forEach((match, index) => {
    const heading = match[2].toUpperCase();
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    sections.push({
      heading,
      body: normalized.slice(start, end).trim()
    });
  });

  return sections;
}

function renderAssistantContent(text = "") {
  const sections = parseAssistantSections(text);
  if (!sections.length) {
    assistantBody.innerHTML = "<section class=\"assistant-section\"><p>Sin contenido.</p></section>";
    return;
  }

  assistantBody.innerHTML = sections.map((section) => {
    const items = section.body
      .split(/\n(?=\d+\.)/)
      .map((item) => item.trim())
      .filter(Boolean);

    const isOrderedList = items.length > 1 && items.every((item) => /^\d+\./.test(item));

    if (isOrderedList) {
      return `
        <section class="assistant-section">
          <h4>${escapeHtml(section.heading)}</h4>
          <ol>
            ${items.map((item) => `<li class="math-text">${renderMathHtml(item.replace(/^\d+\.\s*/, ""))}</li>`).join("")}
          </ol>
        </section>
      `;
    }

    return `
      <section class="assistant-section">
        <h4>${escapeHtml(section.heading)}</h4>
        <p class="math-text">${renderMathHtml(section.body)}</p>
      </section>
    `;
  }).join("");
}

function sendChatMessage() {
  const userName = landingUserNameInput.value.trim();
  const message = chatInput.value.trim();
  if (!joinedRoom || !currentRoomId || !userName || !message) {
    return;
  }

  socket.emit("chat-message", {
    roomId: currentRoomId,
    userName,
    message
  });
  appendChatMessage(userName, message, true);
  chatInput.value = "";
}

function applyRoleView(role = "") {
  currentUserRole = role;
  document.body.classList.remove("role-teacher", "role-student");

  if (role) {
    document.body.classList.add(`role-${role}`);
  }

  workspaceRole.textContent = role === "teacher"
    ? "Maestro"
    : role === "student"
      ? "Estudiante"
      : "Vista libre";

  const isStudent = role === "student";
  teacherRequestInput.readOnly = isStudent;
  exerciseTitleInput.readOnly = isStudent;
  exercisePromptInput.readOnly = isStudent;
  exerciseAnswerInput.readOnly = false;
}

async function ensureLocalAudio() {
  if (localStream) {
    return localStream;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: false
  });

  localStream.getAudioTracks().forEach((track) => {
    track.enabled = audioEnabled;
  });

  setAudioUi(
    audioEnabled
      ? "Micro listo para la sala."
      : "Micro listo, pero entra silenciado por defecto.",
    audioEnabled
  );
  return localStream;
}

function stopLocalAudio() {
  if (!localStream) {
    return;
  }

  localStream.getTracks().forEach((track) => track.stop());
  localStream = null;
  setAudioUi("Micro apagado.", false);
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.ontrack = null;
    peerConnection.close();
    peerConnection = null;
  }

  remoteParticipantId = "";
  remoteAudio.srcObject = null;
}

async function createPeerConnection(targetId) {
  closePeerConnection();
  remoteParticipantId = targetId;
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && remoteParticipantId) {
      socket.emit("webrtc-ice-candidate", {
        targetId: remoteParticipantId,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    const [remoteStream] = event.streams;
    remoteAudio.srcObject = remoteStream;
    audioStatus.textContent = "Audio conectado con la otra persona.";
  };

  const stream = await ensureLocalAudio();
  stream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, stream);
  });
}

async function startCall(targetId) {
  await createPeerConnection(targetId);
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("webrtc-offer", {
    roomId: currentRoomId,
    targetId,
    senderName: landingUserNameInput.value.trim(),
    offer
  });
}

function drawBoardBackground() {
  boardContext.clearRect(0, 0, whiteboard.width, whiteboard.height);
  boardContext.fillStyle = "#fffdf9";
  boardContext.fillRect(0, 0, whiteboard.width, whiteboard.height);
}

function renderBoardImage(dataUrl) {
  if (!dataUrl) {
    lastBoardDataUrl = "";
    drawBoardBackground();
    return;
  }

  if (dataUrl === lastBoardDataUrl) {
    return;
  }

  lastBoardDataUrl = dataUrl;
  const image = new Image();
  image.onload = () => {
    drawBoardBackground();
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    boardContext.drawImage(image, 0, 0, whiteboard.width / pixelRatio, whiteboard.height / pixelRatio);
  };
  image.src = dataUrl;
}

function resizeWhiteboard() {
  const snapshot = lastBoardDataUrl || whiteboard.toDataURL("image/webp", 0.65);
  const rect = whiteboard.getBoundingClientRect();
  const cssWidth = Math.max(280, Math.floor(rect.width));
  const cssHeight = Math.max(320, Math.floor(cssWidth * 0.56));
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);

  whiteboard.width = Math.floor(cssWidth * pixelRatio);
  whiteboard.height = Math.floor(cssHeight * pixelRatio);
  boardContext.setTransform(1, 0, 0, 1, 0, 0);
  boardContext.scale(pixelRatio, pixelRatio);
  drawBoardBackground();

  if (snapshot && snapshot !== "data:,") {
    renderBoardImage(snapshot);
  }
}

function getBoardPoint(event) {
  const rect = whiteboard.getBoundingClientRect();
  const source = event.touches ? event.touches[0] : event;
  return {
    x: source.clientX - rect.left,
    y: source.clientY - rect.top
  };
}

function scheduleBoardSync() {
  if (!joinedRoom || !currentRoomId || currentUserRole === "student") {
    return;
  }

  clearTimeout(boardSyncTimeout);
  boardSyncTimeout = window.setTimeout(() => {
    const boardDataUrl = whiteboard.toDataURL("image/webp", 0.65);
    lastBoardDataUrl = boardDataUrl;
    socket.emit("board-update", {
      roomId: currentRoomId,
      boardDataUrl
    });
  }, 260);
}

function startDrawing(event) {
  if (currentUserRole === "student") {
    return;
  }

  isDrawing = true;
  lastPoint = getBoardPoint(event);
}

function draw(event) {
  if (!isDrawing || !lastPoint) {
    return;
  }

  const point = getBoardPoint(event);
  boardContext.lineCap = "round";
  boardContext.lineJoin = "round";
  boardContext.strokeStyle = boardColorInput.value;
  boardContext.lineWidth = Number(boardSizeInput.value);
  boardContext.beginPath();
  boardContext.moveTo(lastPoint.x, lastPoint.y);
  boardContext.lineTo(point.x, point.y);
  boardContext.stroke();
  lastPoint = point;
}

function stopDrawing() {
  if (isDrawing) {
    scheduleBoardSync();
  }

  isDrawing = false;
  lastPoint = null;
}

function getActiveContext() {
  return {
    subjectName: "Algebra",
    lessonTitle: exerciseTitleInput.value.trim() || "Problema actual",
    lessonSummary: exercisePromptInput.value.trim(),
    lessonCore: exercisePromptInput.value.trim(),
    lessonSteps: [],
    exerciseTitle: exerciseTitleInput.value.trim(),
    exercisePrompt: exercisePromptInput.value,
    exerciseAnswer: exerciseAnswerInput.value,
    teacherRequest: teacherRequestInput.value.trim()
  };
}

function syncExerciseContent() {
  if (!joinedRoom || !currentRoomId || currentUserRole === "student") {
    return;
  }

  socket.emit("exercise-update", {
    roomId: currentRoomId,
    content: {
      title: exerciseTitleInput.value.trim(),
      prompt: exercisePromptInput.value,
      answer: exerciseAnswerInput.value
    }
  });
}

async function runAssistant(action) {
  if (currentUserRole === "student") {
    assistantStatus.textContent = "Solo el maestro puede usar el generador en esta sala.";
    return;
  }

  quickAiButtons.forEach((button) => {
    button.disabled = true;
  });
  assistantStatus.textContent = "Generando contenido...";
  assistantTitle.textContent = "Pensando";
  renderAssistantContent("CONTENIDO\nPreparando respuesta.");

  try {
    const response = await fetch("/api/ai-assist", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        action,
        ...getActiveContext()
      })
    });

    let data;
    try {
      data = await response.json();
    } catch (_error) {
      throw new Error("El servidor devolvio una respuesta invalida.");
    }

    if (!response.ok) {
      throw new Error(data?.error || "La solicitud a la IA no pudo completarse.");
    }

    assistantMode.textContent = data.mode === "groq"
      ? "Groq activo"
      : data.mode === "openai"
        ? "OpenAI activo"
        : "Modo local";
    assistantTitle.textContent = data.title || "Resultado";
    renderAssistantContent(data.body || "No se genero contenido.");
    assistantStatus.textContent = data.reason || "Contenido generado.";

    if (action === "generate-problem" || action === "generate-variant") {
      exerciseTitleInput.value = data.title || exerciseTitleInput.value;
      const sections = parseAssistantSections(data.body || "");
      const exerciseSection = sections.find((section) => section.heading.startsWith("EJERCICIO"));
      exercisePromptInput.value = formatMathText(exerciseSection ? exerciseSection.body : data.body || exercisePromptInput.value);
      syncExerciseContent();
    }
  } catch (error) {
    assistantMode.textContent = "Modo local";
    assistantTitle.textContent = "Sin respuesta";
    renderAssistantContent(`CONTENIDO\nNo pude generar contenido en este momento.\n\nDETALLE\n${error.message || "Error desconocido."}`);
    assistantStatus.textContent = error.message || "La generacion fallo.";
  } finally {
    quickAiButtons.forEach((button) => {
      button.disabled = false;
    });
  }
}

async function joinRoomFlow() {
  const userName = landingUserNameInput.value.trim();
  const roomId = landingRoomIdInput.value.trim();

  if (!userName || !roomId) {
    setStatus("Necesitas escribir tu nombre y un codigo de sala.", false);
    return;
  }

  currentRoomId = roomId;
  await ensureLocalAudio();
  socket.emit("join-room", {
    roomId,
    userName
  });
  setStatus("Conectando a la sala...", false);
  setAudioUi(
    audioEnabled
      ? "Conectando micro a la sala..."
      : "Entraras con el micro silenciado.",
    audioEnabled
  );
}

copyRoomLinkButton.addEventListener("click", async () => {
  const roomId = landingRoomIdInput.value.trim();
  if (!roomId) {
    setStatus("Primero escribe un codigo de sala.", false);
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("room", roomId);
  await navigator.clipboard.writeText(url.toString());
  setStatus("Link copiado.", joinedRoom);
});

landingJoinRoomButton.addEventListener("click", async () => {
  await joinRoomFlow();
});

clearBoardButton.addEventListener("click", () => {
  if (currentUserRole === "student") {
    return;
  }

  drawBoardBackground();
  lastBoardDataUrl = "";
  if (joinedRoom && currentRoomId) {
    socket.emit("board-clear", { roomId: currentRoomId });
  }
});

syncExerciseButton.addEventListener("click", () => {
  syncExerciseContent();
  setStatus("Problema actualizado para la sala.", joinedRoom);
});

clearExerciseButton.addEventListener("click", () => {
  if (currentUserRole === "student") {
    return;
  }

  exerciseTitleInput.value = "";
  exercisePromptInput.value = "";
  exerciseAnswerInput.value = "";
  syncExerciseContent();
});

sendChatButton.addEventListener("click", () => {
  sendChatMessage();
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendChatMessage();
  }
});

toggleAudioButton.addEventListener("click", async () => {
  try {
    await ensureLocalAudio();
    audioEnabled = !audioEnabled;
    localStream.getAudioTracks().forEach((track) => {
      track.enabled = audioEnabled;
    });
    setAudioUi(
      audioEnabled
        ? "Micro activado por ti."
        : "Micro silenciado por ti.",
      audioEnabled
    );
  } catch (_error) {
    setAudioUi("No se pudo activar el micro.", false);
  }
});

quickAiButtons.forEach((button) => {
  button.addEventListener("click", () => {
    runAssistant(button.dataset.action);
  });
});

exerciseAnswerInput.addEventListener("input", () => {
  if (!joinedRoom || !currentRoomId) {
    return;
  }

  socket.emit("exercise-update", {
    roomId: currentRoomId,
    content: {
      title: exerciseTitleInput.value.trim(),
      prompt: exercisePromptInput.value,
      answer: exerciseAnswerInput.value
    }
  });
});

whiteboard.addEventListener("mousedown", startDrawing);
whiteboard.addEventListener("mousemove", draw);
whiteboard.addEventListener("mouseup", stopDrawing);
whiteboard.addEventListener("mouseleave", stopDrawing);
whiteboard.addEventListener("touchstart", (event) => {
  event.preventDefault();
  startDrawing(event);
}, { passive: false });
whiteboard.addEventListener("touchmove", (event) => {
  event.preventDefault();
  draw(event);
}, { passive: false });
whiteboard.addEventListener("touchend", stopDrawing);

window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    resizeWhiteboard();
  }, 120);
});

socket.on("room-joined", async ({ roomId, participantId, role, participants, boardDataUrl, exerciseContent }) => {
  joinedRoom = true;
  currentRoomId = roomId;
  localParticipantId = participantId;
  applyRoleView(role);
  renderBoardImage(boardDataUrl);
  exerciseTitleInput.value = exerciseContent?.title || "";
  exercisePromptInput.value = formatMathText(exerciseContent?.prompt || "");
  exerciseAnswerInput.value = exerciseContent?.answer || "";
  setStatus(`Entraste a la sala ${roomId} como ${role === "teacher" ? "maestro" : "estudiante"}.`, true);
  setAudioUi(
    audioEnabled
      ? "Esperando a la otra persona para hablar."
      : "Entraste con el micro apagado. Activalo solo si quieres hablar.",
    audioEnabled
  );

  const others = (participants || []).filter((participant) => participant.id !== participantId);
  if (others.length) {
    await startCall(others[0].id);
  }
});

socket.on("board-update", ({ boardDataUrl }) => {
  renderBoardImage(boardDataUrl);
});

socket.on("board-clear", () => {
  lastBoardDataUrl = "";
  drawBoardBackground();
});

socket.on("exercise-update", ({ content }) => {
  exerciseTitleInput.value = content?.title || "";
  exercisePromptInput.value = formatMathText(content?.prompt || "");
  exerciseAnswerInput.value = content?.answer || "";
});

socket.on("participant-left", () => {
  setStatus("La otra persona salio de la sala.", joinedRoom);
  closePeerConnection();
  audioStatus.textContent = "La otra persona salio de la sala.";
});

socket.on("chat-message", ({ participantId, userName, message }) => {
  const isOwnMessage = participantId === localParticipantId;
  if (isOwnMessage) {
    return;
  }

  appendChatMessage(userName, message, false);
});

socket.on("room-error", ({ message }) => {
  setStatus(message, false);
});

socket.on("participant-joined", async ({ participantId, userName }) => {
  if (!joinedRoom) {
    return;
  }

  audioStatus.textContent = `${userName} entro a la sala. Conectando audio...`;
  await startCall(participantId);
});

socket.on("webrtc-offer", async ({ participantId, offer, senderName }) => {
  await createPeerConnection(participantId);
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", {
    targetId: participantId,
    answer
  });
  audioStatus.textContent = `Audio conectado con ${senderName}.`;
});

socket.on("webrtc-answer", async ({ answer }) => {
  if (!peerConnection) {
    return;
  }

  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  audioStatus.textContent = "Micro y audio listos.";
});

socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  if (!peerConnection || !candidate) {
    return;
  }

  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (_error) {
    audioStatus.textContent = "Seguimos intentando estabilizar el audio.";
  }
});

const roomFromUrl = new URLSearchParams(window.location.search).get("room");
landingRoomIdInput.value = roomFromUrl || createRoomId();
applyRoleView("");
setStatus("Escribe tu nombre y un codigo de sala para empezar.", false);
setAudioUi("Micro apagado.", false);
updateChatState();
renderAssistantContent("CONTENIDO\nPulsa un boton para generar contenido.");
resizeWhiteboard();
drawBoardBackground();

window.addEventListener("beforeunload", () => {
  stopLocalAudio();
  closePeerConnection();
});
