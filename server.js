const http = require("http");
const path = require("path");

require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const aiProvider = process.env.GROQ_API_KEY
  ? {
      name: "groq",
      model: groqModel,
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1"
      })
    }
  : process.env.OPENAI_API_KEY
    ? {
        name: "openai",
        model: "gpt-4.1-mini",
        client: new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        })
      }
    : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function buildFallbackAssistantResponse(action, payload) {
  const subject = payload.subjectName || "la materia actual";
  const lessonTitle = payload.lessonTitle || "el tema activo";
  const lessonSummary = payload.lessonSummary || "";
  const exerciseTitle = payload.exerciseTitle || "Ejercicio guiado";
  const exercisePrompt = payload.exercisePrompt || "";
  const studentAnswer = payload.exerciseAnswer || "";
  const teacherRequest = payload.teacherRequest || "";

  if (action === "explain") {
    return {
      title: `Explicacion guiada de ${lessonTitle}`,
      body: `EXPLICACION\n${lessonSummary || `Explica la idea principal de ${lessonTitle} con una frase clara y directa.`}\n\nPASOS\n1. Presenta el concepto.\n2. Relaciona el tema con una situacion sencilla.\n3. Muestra el procedimiento paso a paso en la pizarra.\n4. Comprueba si el alumno entendio con una pregunta corta.`
    };
  }

  if (action === "example") {
    return {
      title: `Ejemplo rapido para ${lessonTitle}`,
      body: `EXPLICACION\nEste ejemplo sirve para mostrar como se aplica ${lessonTitle} en ${subject}.\n\nEJEMPLO\nUsa un caso corto y visual para resolverlo en voz alta.\n\nPASOS\n1. Explica que se busca.\n2. Muestra los datos iniciales.\n3. Resuelve paso a paso.\n4. Pide al alumno repetir la idea final con sus palabras.`
    };
  }

  if (action === "exercise") {
    return {
      title: exercisePrompt ? `Variacion de ${exerciseTitle}` : `Nuevo ejercicio para ${lessonTitle}`,
      body: exercisePrompt
        ? `EJERCICIO\nToma este ejercicio base y crea una version parecida con dificultad media:\n${exercisePrompt}\n\nPISTA\nPide al alumno agrupar ideas o terminos semejantes antes de operar.\n\nSOLUCION\nEl profesor debe resolverlo mostrando cada paso, no solo el resultado final.`
        : `EJERCICIO\nPropone un ejercicio corto sobre ${lessonTitle} en ${subject}.\n\nPISTA\nIncluye una ayuda breve para destrabar al alumno.\n\nSOLUCION\nAgrega una respuesta esperada para el profesor.`
    };
  }

  if (action === "generate-problem") {
    return {
      title: `Problema generado para ${subject}`,
      body: teacherRequest
        ? `EXPLICACION\nEl siguiente problema busca un nivel mas cercano a algebra clasica de practica formal, con varios pasos y cuidado en signos y exponentes.\n\nEJERCICIO\nSimplifica y reduce a su minima expresion:\n[3x^2y - 2xy^2 + 5y^3 - (4x^2y - xy^2 + 2y^3)] - [2x^2y - 3xy^2 - (y^3 - x^2y)] + 4xy^2\n\nPISTA\nPrimero elimina los corchetes internos. Despues distribuye correctamente el signo menos del segundo bloque. Al final reune terminos semejantes en x^2y, xy^2 y y^3.\n\nSOLUCION\n1. Resuelve el primer corchete: 3x^2y - 2xy^2 + 5y^3 - 4x^2y + xy^2 - 2y^3 = -x^2y - xy^2 + 3y^3.\n2. Resuelve el segundo corchete: 2x^2y - 3xy^2 - y^3 + x^2y = 3x^2y - 3xy^2 - y^3.\n3. Aplica el signo menos delante del segundo bloque: -3x^2y + 3xy^2 + y^3.\n4. Suma todo con 4xy^2.\n5. Resultado final: -4x^2y + 6xy^2 + 4y^3.`
        : `EXPLICACION\nSe propone un ejercicio de algebra menos trivial, con varios agrupamientos y mas de un nivel de parentesis.\n\nEJERCICIO\nSimplifica y ordena:\n2a - [3b - 2(a - b + 3c)] + 4[a - (2b - c)] - [a - 2(b - c)]\n\nPISTA\nQuita parentesis desde adentro hacia afuera. Ten cuidado con los signos menos que cambian todos los terminos del grupo.\n\nSOLUCION\n1. 3b - 2(a - b + 3c) = 3b - 2a + 2b - 6c = -2a + 5b - 6c.\n2. 4[a - (2b - c)] = 4(a - 2b + c) = 4a - 8b + 4c.\n3. [a - 2(b - c)] = a - 2b + 2c.\n4. Sustituye y opera: 2a - (-2a + 5b - 6c) + 4a - 8b + 4c - (a - 2b + 2c).\n5. Resultado final: 7a - 11b + 8c.`
    };
  }

  if (action === "give-hint") {
    return {
      title: `Pista para ${exerciseTitle || lessonTitle}`,
      body: `PISTA\nNo resuelvas todo de golpe.\n1. Observa que terminos tienen la misma parte literal.\n2. Quita con cuidado los parentesis.\n3. Agrupa los terminos semejantes.\n4. Suma primero los de mayor grado.`
    };
  }

  if (action === "solve-step-by-step") {
    return {
      title: `Resolucion guiada de ${exerciseTitle || lessonTitle}`,
      body: exercisePrompt
        ? `SOLUCION PASO A PASO\n1. Copia el ejercicio: ${exercisePrompt}\n2. Elimina parentesis respetando signos.\n3. Agrupa terminos semejantes.\n4. Opera termino por termino.\n5. Ordena el resultado de mayor a menor grado.\n\nCIERRE\nPide al alumno explicar por que algunos terminos si se pueden sumar y otros no.`
        : `SOLUCION PASO A PASO\n1. Escribe el polinomio o expresion.\n2. Elimina parentesis con cuidado.\n3. Agrupa terminos semejantes.\n4. Opera coeficientes.\n5. Ordena el resultado final.`
    };
  }

  if (action === "generate-variant") {
    return {
      title: `Variante de ${exerciseTitle || lessonTitle}`,
      body: `EXPLICACION\nAqui tienes una variante del mismo tipo, pero con otra combinacion de signos y terminos.\n\nEJERCICIO\nReduce y ordena:\n(5m^2n - 3mn^2 + 4n^3) - [2m^2n - (mn^2 - 3n^3)] + [m^2n - 2(mn^2 - n^3)]\n\nPISTA\nResuelve primero cada parentesis interior y despues suma los terminos semejantes.\n\nSOLUCION\nOrganiza por columnas los terminos en m^2n, mn^2 y n^3 antes de dar el resultado final.`
    };
  }

  return {
    title: `Retroalimentacion para ${lessonTitle}`,
    body: studentAnswer
      ? `RETROALIMENTACION\nAnaliza esta respuesta del alumno:\n${studentAnswer}\n\nQUE HIZO BIEN\nReconoce primero el avance correcto.\n\nQUE DEBE CORREGIR\nMarca un solo error principal.\n\nSIGUIENTE PASO\nIndica que debe intentar despues con una pista breve.`
      : `RETROALIMENTACION\nCuando el alumno termine, revisa si entendio la idea central de ${lessonTitle}, si explico el procedimiento y si puede repetirlo sin ayuda.`
  };
}

app.post("/api/ai-assist", async (req, res) => {
  const {
    action,
    subjectName,
    lessonTitle,
    lessonSummary,
    lessonCore,
    lessonSteps,
    exerciseTitle,
    exercisePrompt,
    exerciseAnswer,
    teacherRequest
  } = req.body || {};

  if (!action) {
    res.status(400).json({ error: "Falta la accion solicitada." });
    return;
  }

  if (!aiProvider) {
    res.json({
      mode: "fallback",
      ...buildFallbackAssistantResponse(action, {
        subjectName,
        lessonTitle,
        lessonSummary,
        exerciseTitle,
        exercisePrompt,
        exerciseAnswer,
        teacherRequest
      })
    });
    return;
  }

  try {
    const actionLabelMap = {
      explain: "crear una explicacion clara para ensenar el tema",
      example: "crear un ejemplo corto y didactico",
      exercise: "crear o mejorar un ejercicio para el alumno",
      feedback: "dar retroalimentacion sobre la respuesta del alumno",
      "generate-problem": "crear un problema nuevo y bien elaborado para el alumno",
      "give-hint": "dar una pista util sin resolver todo",
      "solve-step-by-step": "resolver con procedimiento claro paso a paso",
      "generate-variant": "crear otro problema parecido con dificultad comparable"
    };

    const prompt = [
      `Accion: ${actionLabelMap[action] || action}`,
      `Materia: ${subjectName || "General"}`,
      `Tema: ${lessonTitle || "Sin tema"}`,
      `Resumen del tema: ${lessonSummary || "Sin resumen"}`,
      `Idea central: ${lessonCore || "Sin idea central"}`,
      `Pasos sugeridos: ${(lessonSteps || []).join(" | ") || "Sin pasos"}`,
      `Titulo del ejercicio: ${exerciseTitle || "Sin titulo"}`,
      `Enunciado del ejercicio: ${exercisePrompt || "Sin enunciado"}`,
      `Respuesta del alumno: ${exerciseAnswer || "Sin respuesta"}`,
      `Pedido del profesor: ${teacherRequest || "Sin pedido adicional"}`,
      "Responde en espanol.",
      "Devuelve JSON valido con esta forma exacta: {\"title\":\"...\",\"body\":\"...\"}.",
      "El contenido debe ser didactico, claro, breve y util para una clase en vivo.",
      "Cuando genere problemas o apoyo, separa el contenido con bloques claros usando titulos como EXPLICACION, EJERCICIO, PISTA, SOLUCION o RETROALIMENTACION.",
      "No respondas en parrafos ambiguos. Hazlo facil de leer para un profesor y un alumno.",
      "Si el pedido es de algebra, polinomios o estilo Baldor, evita ejercicios demasiado simples de una sola combinacion directa.",
      "Prefiere problemas con varios pasos, parentesis, signos, terminos semejantes no obvios, factorizacion, productos notables o simplificacion estructurada segun corresponda.",
      "Si generas un ejercicio, procura que parezca de libro clasico: formal, limpio, retador pero resoluble."
    ].join("\n");

    const response = await aiProvider.client.responses.create({
      model: aiProvider.model,
      input: [
        {
          role: "system",
          content: "Eres un asistente pedagogico para clases en vivo. Ayudas a un docente a explicar mejor, dar ejemplos y crear ejercicios claros."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const text = response.output_text || "";
    const parsed = JSON.parse(text);
    res.json({
      mode: aiProvider.name,
      title: parsed.title,
      body: parsed.body
    });
  } catch (_error) {
    res.json({
      mode: "fallback",
      ...buildFallbackAssistantResponse(action, {
        subjectName,
        lessonTitle,
        lessonSummary,
        exerciseTitle,
        exercisePrompt,
        exerciseAnswer,
        teacherRequest
      })
    });
  }
});

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      members: new Map(),
      boardDataUrl: "",
      exerciseContent: {
        title: "",
        prompt: "",
        answer: ""
      }
    });
  }

  return rooms.get(roomId);
}

function serializeMembers(room) {
  return Array.from(room.members.values()).map((member) => ({
    id: member.id,
    name: member.name,
    role: member.role
  }));
}

function removeSocketFromRoom(socket) {
  const { roomId } = socket.data;
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  room.members.delete(socket.id);

  socket.to(roomId).emit("participant-left", {
    participantId: socket.id
  });

  io.to(roomId).emit("room-members", serializeMembers(room));

  if (room.members.size === 0) {
    rooms.delete(roomId);
  }
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userName }) => {
    if (!roomId || !userName) {
      socket.emit("room-error", {
        message: "Faltan datos para entrar a la sala."
      });
      return;
    }

    removeSocketFromRoom(socket);

    const room = getRoomState(roomId);
    if (room.members.size >= 2) {
      socket.emit("room-error", {
        message: "Esta sala ya tiene un maestro y un estudiante."
      });
      return;
    }

    const role = room.members.size === 0 ? "teacher" : "student";
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName;
    socket.data.role = role;

    room.members.set(socket.id, {
      id: socket.id,
      name: userName,
      role
    });

    socket.emit("room-joined", {
      roomId,
      participantId: socket.id,
      role,
      participants: serializeMembers(room),
      boardDataUrl: room.boardDataUrl,
      exerciseContent: room.exerciseContent
    });

    socket.to(roomId).emit("participant-joined", {
      participantId: socket.id,
      userName,
      role
    });

    io.to(roomId).emit("room-members", serializeMembers(room));
  });

  socket.on("webrtc-offer", ({ roomId, targetId, offer, senderName }) => {
    io.to(targetId).emit("webrtc-offer", {
      participantId: socket.id,
      senderName,
      offer,
      roomId
    });
  });

  socket.on("webrtc-answer", ({ targetId, answer }) => {
    io.to(targetId).emit("webrtc-answer", {
      participantId: socket.id,
      answer
    });
  });

  socket.on("webrtc-ice-candidate", ({ targetId, candidate }) => {
    io.to(targetId).emit("webrtc-ice-candidate", {
      participantId: socket.id,
      candidate
    });
  });

  socket.on("chat-message", ({ roomId, userName, message }) => {
    if (!roomId || !message) {
      return;
    }

    io.to(roomId).emit("chat-message", {
      participantId: socket.id,
      userName,
      message,
      createdAt: new Date().toISOString()
    });
  });

  socket.on("board-update", ({ roomId, boardDataUrl }) => {
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.boardDataUrl = boardDataUrl || "";
    socket.to(roomId).emit("board-update", {
      boardDataUrl: room.boardDataUrl
    });
  });

  socket.on("board-clear", ({ roomId }) => {
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.boardDataUrl = "";
    io.to(roomId).emit("board-clear");
  });

  socket.on("exercise-update", ({ roomId, content }) => {
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.exerciseContent = {
      title: content?.title || "",
      prompt: content?.prompt || "",
      answer: content?.answer || ""
    };

    socket.to(roomId).emit("exercise-update", {
      content: room.exerciseContent
    });
  });

  socket.on("leave-room", () => {
    removeSocketFromRoom(socket);
    socket.leave(socket.data.roomId);
    socket.data.roomId = "";
    socket.data.userName = "";
    socket.data.role = "";
  });

  socket.on("disconnect", () => {
    removeSocketFromRoom(socket);
  });
});

server.listen(PORT, () => {
  console.log(`ExplicaLab en vivo en http://localhost:${PORT}`);
});
