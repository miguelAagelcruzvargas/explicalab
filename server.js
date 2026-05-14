const http = require("http");
const fs = require("fs");
const path = require("path");

require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const pdfParse = require("pdf-parse");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const groqModel = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const baldorPdfPath = path.join(__dirname, "Solucionario Álgebra de Baldor.pdf");
const baldorCachePath = path.join(__dirname, "data", "baldor-reference-cache.json");
const baldorReference = {
  loaded: false,
  available: false,
  text: "",
  entries: [],
  error: ""
};
const aiProvider = process.env.GROQ_API_KEY
  ? {
      name: "groq",
      model: groqModel,
      kind: "chat.completions",
      client: new OpenAI({
        apiKey: process.env.GROQ_API_KEY,
        baseURL: "https://api.groq.com/openai/v1"
      })
    }
  : process.env.OPENAI_API_KEY
    ? {
        name: "openai",
        model: "gpt-4.1-mini",
        kind: "responses",
        client: new OpenAI({
          apiKey: process.env.OPENAI_API_KEY
        })
      }
    : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname)));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    provider: aiProvider ? aiProvider.name : "fallback",
    baldorReference: baldorReference.available ? "ready" : baldorReference.error || "pending",
    baldorEntries: baldorReference.entries.length
  });
});

async function loadBaldorReference() {
  if (baldorReference.loaded) {
    return baldorReference;
  }

  baldorReference.loaded = true;

  try {
    if (!fs.existsSync(baldorPdfPath)) {
      baldorReference.error = "PDF_NO_ENCONTRADO";
      return baldorReference;
    }

    const buffer = fs.readFileSync(baldorPdfPath);
    const parsed = await pdfParse(buffer);
    baldorReference.text = String(parsed.text || "")
      .replace(/\r/g, "")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    baldorReference.entries = buildLocalBaldorKnowledgeBase(baldorReference.text);
    baldorReference.available = Boolean(baldorReference.text);

    if (baldorReference.entries.length) {
      fs.mkdirSync(path.dirname(baldorCachePath), { recursive: true });
      fs.writeFileSync(
        baldorCachePath,
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          source: path.basename(baldorPdfPath),
          entries: baldorReference.entries
        }, null, 2),
        "utf8"
      );
    }

    if (!baldorReference.available) {
      baldorReference.error = "PDF_SIN_TEXTO";
    }
  } catch (error) {
    baldorReference.error = error.message || "PDF_NO_PROCESADO";
  }

  return baldorReference;
}

function normalizeKnowledgeText(text = "") {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function classifyKnowledgeTopic(text = "") {
  const sample = text.toLowerCase();

  if (/clasific|monom|binomi|trinomi|polinomi|expresion algebraica/.test(sample)) {
    return "classification";
  }

  if (/terminos semejantes|reduccion|reducir|simplifica|ordena/.test(sample)) {
    return "reduction";
  }

  if (/producto notable|binomio al cuadrado|binomios conjugados|cuadrado de un binomio/.test(sample)) {
    return "notable-products";
  }

  if (/factoriz|factor comun|trinomio cuadrado perfecto|diferencia de cuadrados/.test(sample)) {
    return "factorization";
  }

  if (/fraccion algebraica|fracciones algebraicas/.test(sample)) {
    return "algebraic-fractions";
  }

  if (/ecuacion|incognita|despejar/.test(sample)) {
    return "equations";
  }

  return "general-algebra";
}

function buildLocalBaldorKnowledgeBase(sourceText = "") {
  const normalized = normalizeKnowledgeText(sourceText);
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n\n+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 80);

  const entries = [];

  paragraphs.forEach((paragraph, index) => {
    const compact = paragraph.replace(/\n/g, " ").trim();
    if (compact.length < 80) {
      return;
    }

    const topic = classifyKnowledgeTopic(compact);
    const titleMatch = compact.match(/^(ejercicio|regla|definicion|solucion|teorema)\s*\d*/i);
    entries.push({
      id: `baldor-${index + 1}`,
      topic,
      title: titleMatch ? titleMatch[0] : `Referencia ${index + 1}`,
      text: compact.slice(0, 1200)
    });
  });

  return entries.slice(0, 400);
}

function scoreKnowledgeEntry(entry, searchText, topic) {
  let score = 0;
  const haystack = `${entry.topic} ${entry.title} ${entry.text}`.toLowerCase();

  if (entry.topic === topic) {
    score += 8;
  }

  searchText
    .split(/\s+/)
    .filter((word) => word.length >= 4)
    .forEach((word) => {
      if (haystack.includes(word)) {
        score += 2;
      }
    });

  return score;
}

function getBaldorReferenceContext(payload) {
  if (!baldorReference.available || !baldorReference.entries.length) {
    return "";
  }

  const searchBase = [
    payload.subjectName,
    payload.lessonTitle,
    payload.lessonSummary,
    payload.exerciseTitle,
    payload.exercisePrompt,
    payload.teacherRequest
  ]
    .join(" ")
    .toLowerCase();
  const topic = detectBaldorTopic(payload);
  const selected = baldorReference.entries
    .map((entry) => ({
      ...entry,
      score: scoreKnowledgeEntry(entry, searchBase, topic)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  return selected
    .map((entry) => `[${entry.topic}] ${entry.text}`)
    .join("\n\n")
    .slice(0, 2600);
}

async function requestAiJson(prompt) {
  if (!aiProvider) {
    throw new Error("AI_PROVIDER_MISSING");
  }

  if (aiProvider.kind === "chat.completions") {
    const completion = await aiProvider.client.chat.completions.create({
      model: aiProvider.model,
      temperature: 0.7,
      messages: [
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

    return completion.choices?.[0]?.message?.content || "";
  }

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

  return response.output_text || "";
}

function parseAiResponse(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) {
    throw new Error("AI_EMPTY_RESPONSE");
  }

  const withoutFences = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const candidates = [withoutFences];
  const firstBrace = withoutFences.indexOf("{");
  const lastBrace = withoutFences.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(withoutFences.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") {
        return {
          title: parsed.title || "Resultado IA",
          body: parsed.body || candidate
        };
      }
    } catch (_error) {
      continue;
    }
  }

  const titleMatch = withoutFences.match(/"title"\s*:\s*"([^"]+)"/i);
  const bodyMatch = withoutFences.match(/"body"\s*:\s*"([\s\S]*)"\s*}\s*$/i);
  if (titleMatch || bodyMatch) {
    const rawBody = bodyMatch ? bodyMatch[1] : withoutFences;
    return {
      title: titleMatch ? titleMatch[1].trim() : "Resultado IA",
      body: rawBody
        .replace(/\\"/g, "\"")
        .replace(/\\n/g, "\n")
        .replace(/^\s*##\s*/gm, "")
        .trim()
    };
  }

  return {
    title: "Resultado IA",
    body: withoutFences
      .replace(/^\s*##\s*/gm, "")
      .trim()
  };
}

function pickOne(items, seedText = "") {
  if (!items.length) {
    return null;
  }

  const seed = String(seedText || "baldor")
    .split("")
    .reduce((total, char) => total + char.charCodeAt(0), 0);

  return items[seed % items.length];
}

function detectBaldorTopic(payload) {
  const source = [
    payload.subjectName,
    payload.lessonTitle,
    payload.lessonSummary,
    payload.exerciseTitle,
    payload.exercisePrompt,
    payload.teacherRequest
  ].join(" ").toLowerCase();

  if (/clasific|monom|binomi|trinomi|polinomi|expresiones algebraicas/.test(source)) {
    return "classification";
  }

  if (/terminos semejantes|reduccion|reduc|simplifica|ordena/.test(source)) {
    return "reduction";
  }

  if (/productos notables|cuadrado de un binomio|binomio al cuadrado|binomios conjugados/.test(source)) {
    return "notable-products";
  }

  if (/factoriz|factorizacion|factoriza/.test(source)) {
    return "factorization";
  }

  if (/fracciones algebraicas|fraccion algebraica/.test(source)) {
    return "algebraic-fractions";
  }

  if (/ecuacion|ecuaciones|primer grado|segundo grado/.test(source)) {
    return "equations";
  }

  return "general-algebra";
}

function buildBaldorProblemSet(payload, variant = false) {
  const topic = detectBaldorTopic(payload);
  const source = [payload.teacherRequest, payload.lessonTitle, payload.exercisePrompt].join(" ");

  const problemBank = {
    classification: [
      {
        title: "Clasificacion de expresiones algebraicas",
        body: `EXPLICACION\nEn algebra clasica, una expresion se clasifica por su numero de terminos y por su grado. Conviene distinguir primero cuantas partes separadas por signos de suma o resta tiene cada expresion.\n\nEJERCICIO\nClasifica por numero de terminos y por grado las siguientes expresiones:\n1. 7a^2b - 3ab + 5\n2. x^3 - 4x^2 + x - 9\n3. 6m^4n\n4. 2p^2 - 5p\n5. 3y^2 - 2y + 1 - y^3\n\nPISTA\nPrimero cuenta los terminos. Despues identifica el mayor exponente total de cada expresion.\n\nSOLUCION\n1. 7a^2b - 3ab + 5 tiene tres terminos: es un trinomio. Su grado mayor es 3 por el termino a^2b.\n2. x^3 - 4x^2 + x - 9 tiene cuatro terminos: es un polinomio. Su grado es 3.\n3. 6m^4n tiene un solo termino: es un monomio. Su grado total es 5.\n4. 2p^2 - 5p tiene dos terminos: es un binomio. Su grado es 2.\n5. 3y^2 - 2y + 1 - y^3 tiene cuatro terminos: es un polinomio. Su grado es 3.`
      },
      {
        title: "Clasificacion de monomios, binomios y polinomios",
        body: `EXPLICACION\nPara clasificar correctamente una expresion algebraica, se cuentan sus terminos y se observa cual de ellos tiene mayor grado.\n\nEJERCICIO\nIndica si cada una de las siguientes expresiones es monomio, binomio, trinomio o polinomio, y senala su grado:\n1. 5x^4 - 2x^2 + 7x\n2. 9a^3b^2\n3. m - n + p - q\n4. 4z^2 + 6z - 1\n5. x^2y - 3xy^2 + y^3 - 8\n\nPISTA\nCuando haya varias letras, suma los exponentes del mismo termino para hallar su grado total.\n\nSOLUCION\n1. Trinomio de grado 4.\n2. Monomio de grado 5.\n3. Polinomio de cuatro terminos y grado 1.\n4. Trinomio de grado 2.\n5. Polinomio de cuatro terminos y grado 3.`
      }
    ],
    reduction: [
      {
        title: "Reduccion de terminos semejantes",
        body: `EXPLICACION\nEste ejercicio trabaja la reduccion de expresiones con parentesis, signos contrarios y terminos semejantes no inmediatos, como suele verse en algebra elemental clasica.\n\nEJERCICIO\nReducir a su mas simple expresion:\n[5x^2 - 3xy + 2y^2 - (2x^2 - xy + y^2)] - [x^2 - 4xy + 3y^2 - (2xy - y^2)] + 3xy\n\nPISTA\nResuelve primero cada parentesis interior. Despues aplica el signo menos delante del segundo corchete y, por ultimo, reune los terminos semejantes.\n\nSOLUCION\n1. Primer corchete: 5x^2 - 3xy + 2y^2 - 2x^2 + xy - y^2 = 3x^2 - 2xy + y^2.\n2. Segundo corchete: x^2 - 4xy + 3y^2 - 2xy + y^2 = x^2 - 6xy + 4y^2.\n3. Restando el segundo corchete: -x^2 + 6xy - 4y^2.\n4. Sumando todo: 3x^2 - 2xy + y^2 - x^2 + 6xy - 4y^2 + 3xy.\n5. Resultado final: 2x^2 + 7xy - 3y^2.`
      },
      {
        title: "Simplificacion ordenada de expresiones algebraicas",
        body: `EXPLICACION\nLa reduccion exige quitar parentesis con rigor y reunir unicamente los terminos que tengan la misma parte literal.\n\nEJERCICIO\nSimplifica y ordena:\n3a - [2b - 3(a - b + 2c)] + 2[a - (b - 3c)] - [4a - 2(b - c)]\n\nPISTA\nTrabaja de adentro hacia afuera. Cada signo menos delante de un parentesis cambia los signos interiores.\n\nSOLUCION\n1. 2b - 3(a - b + 2c) = 2b - 3a + 3b - 6c = -3a + 5b - 6c.\n2. 2[a - (b - 3c)] = 2(a - b + 3c) = 2a - 2b + 6c.\n3. [4a - 2(b - c)] = 4a - 2b + 2c.\n4. Sustituyendo: 3a - (-3a + 5b - 6c) + 2a - 2b + 6c - (4a - 2b + 2c).\n5. Resultado final: 4a - 5b + 10c.`
      }
    ],
    "notable-products": [
      {
        title: "Productos notables",
        body: `EXPLICACION\nLos productos notables se reconocen por su forma. Antes de multiplicar termino a termino, conviene identificar si se trata del cuadrado de un binomio o del producto de binomios conjugados.\n\nEJERCICIO\nDesarrolla y simplifica:\n1. (3x - 2y)^2\n2. (2a + 5b)^2\n3. (m + 4n)(m - 4n)\n4. (x - 3)(x - 3)\n\nPISTA\nRecuerda estas formas:\n(a + b)^2 = a^2 + 2ab + b^2\n(a - b)^2 = a^2 - 2ab + b^2\n(a + b)(a - b) = a^2 - b^2\n\nSOLUCION\n1. (3x - 2y)^2 = 9x^2 - 12xy + 4y^2.\n2. (2a + 5b)^2 = 4a^2 + 20ab + 25b^2.\n3. (m + 4n)(m - 4n) = m^2 - 16n^2.\n4. (x - 3)^2 = x^2 - 6x + 9.`
      }
    ],
    factorization: [
      {
        title: "Factorizacion clasica",
        body: `EXPLICACION\nEn factorizacion conviene buscar primero factor comun, luego reconocer trinomios o diferencias de cuadrados, segun la forma de la expresion.\n\nEJERCICIO\nFactoriza completamente:\n1. 6x^2 - 9x\n2. x^2 - 10x + 25\n3. 4a^2 - 25b^2\n4. 3m^2n - 12mn^2\n\nPISTA\nObserva si todos los terminos comparten factor comun. Si no, revisa si la expresion coincide con una identidad notable.\n\nSOLUCION\n1. 6x^2 - 9x = 3x(2x - 3).\n2. x^2 - 10x + 25 = (x - 5)^2.\n3. 4a^2 - 25b^2 = (2a - 5b)(2a + 5b).\n4. 3m^2n - 12mn^2 = 3mn(m - 4n).`
      }
    ],
    "algebraic-fractions": [
      {
        title: "Fracciones algebraicas",
        body: `EXPLICACION\nPara simplificar fracciones algebraicas primero se factoriza numerador y denominador. Solo despues pueden cancelarse factores comunes.\n\nEJERCICIO\nSimplifica:\n1. (6x^2 - 12x)/(3x)\n2. (x^2 - 9)/(x - 3)\n3. (a^2 - 4a)/(a)\n\nPISTA\nNo canceles terminos sueltos. Solo se cancelan factores completos.\n\nSOLUCION\n1. (6x^2 - 12x)/(3x) = 6x(x - 2)/(3x) = 2(x - 2).\n2. (x^2 - 9)/(x - 3) = (x - 3)(x + 3)/(x - 3) = x + 3.\n3. (a^2 - 4a)/a = a(a - 4)/a = a - 4.`
      }
    ],
    equations: [
      {
        title: "Ecuaciones elementales de algebra",
        body: `EXPLICACION\nResolver ecuaciones exige ordenar primero, reducir terminos semejantes y despejar la incognita con operaciones equivalentes en ambos miembros.\n\nEJERCICIO\nResuelve:\n1. 3x - 5 = 16\n2. 4(2x - 1) = 3x + 9\n3. 5 - [2x - (3 - x)] = 8\n\nPISTA\nEn cada ecuacion, simplifica ambos lados antes de despejar.\n\nSOLUCION\n1. 3x = 21, luego x = 7.\n2. 8x - 4 = 3x + 9, entonces 5x = 13 y x = 13/5.\n3. 5 - 2x + 3 - x = 8, por tanto 8 - 3x = 8, luego x = 0.`
      }
    ],
    "general-algebra": [
      {
        title: "Ejercicio clasico de algebra",
        body: `EXPLICACION\nEste ejercicio mezcla simplificacion, signos y reduccion de terminos semejantes, con el estilo de practica ordenada de un texto clasico de algebra.\n\nEJERCICIO\nReducir a su minima expresion:\n2x - [3y - 2(x - y + z)] + 4[x - (y - 2z)] - [2x - 3(y - z)]\n\nPISTA\nSuprime parentesis con cuidado y escribe juntos los terminos en x, en y y en z.\n\nSOLUCION\n1. 3y - 2(x - y + z) = 3y - 2x + 2y - 2z = -2x + 5y - 2z.\n2. 4[x - (y - 2z)] = 4x - 4y + 8z.\n3. [2x - 3(y - z)] = 2x - 3y + 3z.\n4. Sustituyendo y reduciendo: 2x - (-2x + 5y - 2z) + 4x - 4y + 8z - (2x - 3y + 3z).\n5. Resultado final: 6x - 6y + 7z.`
      },
      {
        title: "Practica general estilo algebra elemental",
        body: `EXPLICACION\nLa finalidad de este problema es ejercitar la observacion de signos, la reduccion ordenada y el manejo correcto de parentesis.\n\nEJERCICIO\nSimplifica y ordena:\n[4a^2 - 3ab + 2b^2] - [2a^2 - ab - b^2] + [a^2 - 2ab + 3b^2] - (ab - 2b^2)\n\nPISTA\nOrdena los terminos por especie: a^2, ab y b^2.\n\nSOLUCION\n1. Cambia signos donde sea necesario y elimina parentesis.\n2. Queda: 4a^2 - 3ab + 2b^2 - 2a^2 + ab + b^2 + a^2 - 2ab + 3b^2 - ab + 2b^2.\n3. Reune terminos semejantes.\n4. Resultado final: 3a^2 - 5ab + 8b^2.`
      }
    ]
  };

  const selectedTopic = variant && topic === "general-algebra" ? "reduction" : topic;
  const chosen = pickOne(problemBank[selectedTopic] || problemBank["general-algebra"], source);
  return chosen;
}

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
    const generatedProblem = buildBaldorProblemSet(payload, false);
    return {
      title: generatedProblem.title || `Problema generado para ${subject}`,
      body: generatedProblem.body
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
    const variantProblem = buildBaldorProblemSet(payload, true);
    return {
      title: `Variante de ${variantProblem.title || exerciseTitle || lessonTitle}`,
      body: variantProblem.body
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

  await loadBaldorReference();

  if (!aiProvider) {
    res.json({
      mode: "fallback",
      reason: "No hay proveedor de IA configurado en el servidor.",
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

    const baldorContext = getBaldorReferenceContext({
      subjectName,
      lessonTitle,
      lessonSummary,
      exerciseTitle,
      exercisePrompt,
      teacherRequest
    });

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
      baldorContext ? `Contexto de referencia inspirado en el PDF local de Baldor:\n${baldorContext}` : "No hay contexto adicional de Baldor disponible.",
      "Responde en espanol.",
      "Devuelve JSON valido con esta forma exacta: {\"title\":\"...\",\"body\":\"...\"}.",
      "No uses markdown, no uses ``` y no pongas ## en los encabezados.",
      "Dentro de body escribe encabezados limpios en mayusculas como EXPLICACION, EJERCICIO, PISTA, SOLUCION y RETROALIMENTACION.",
      "El contenido debe ser didactico, claro, breve y util para una clase en vivo.",
      "Cuando genere problemas o apoyo, separa el contenido con bloques claros usando titulos como EXPLICACION, EJERCICIO, PISTA, SOLUCION o RETROALIMENTACION.",
      "No respondas en parrafos ambiguos. Hazlo facil de leer para un profesor y un alumno.",
      "Si el profesor pide contenido tipo Baldor o algebra clasica, responde con estilo de libro de algebra elemental: formal, limpio, gradual y centrado en una habilidad concreta.",
      "Para Baldor prioriza temas como clasificacion de expresiones, reduccion de terminos semejantes, productos notables, factorizacion, fracciones algebraicas, exponentes, radicales y ecuaciones.",
      "Incluye explicacion breve, enunciado bien redactado, pista util y solucion ordenada, como material de clase y practica.",
      "Usa el contexto de referencia solo para inspirarte en estilo, temas y nivel. No copies textualmente fragmentos largos ni reproduzcas el solucionario tal cual.",
      "Si el pedido es de algebra, polinomios o estilo Baldor, evita ejercicios demasiado simples de una sola combinacion directa.",
      "Prefiere problemas con varios pasos, parentesis, signos, terminos semejantes no obvios, factorizacion, productos notables o simplificacion estructurada segun corresponda.",
      "Si generas un ejercicio, procura que parezca de libro clasico: formal, limpio, retador pero resoluble."
    ].join("\n");

    const text = await requestAiJson(prompt);
    if (!text.trim()) {
      throw new Error("AI_EMPTY_RESPONSE");
    }

    const parsed = parseAiResponse(text);
    res.json({
      mode: aiProvider.name,
      title: parsed.title,
      body: parsed.body,
      reason: `Respuesta generada con ${aiProvider.name}.`
    });
  } catch (error) {
    res.json({
      mode: "fallback",
      reason: `La IA real fallo y se uso respaldo local. Motivo: ${error.message}`,
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
      teacherKey: "",
      studentKey: "",
      boardDataUrl: "",
      challenge: {
        active: false,
        endsAt: 0,
        durationSeconds: 0,
        label: ""
      },
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

function removeMemberFromRoom(roomId, memberId, emitEvents = true) {
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  const room = rooms.get(roomId);
  if (!room.members.has(memberId)) {
    return;
  }

  room.members.delete(memberId);

  if (emitEvents) {
    io.to(roomId).emit("participant-left", {
      participantId: memberId
    });

    io.to(roomId).emit("room-members", serializeMembers(room));
  }

  if (room.members.size === 0) {
    rooms.delete(roomId);
  }
}

function removeSocketFromRoom(socket) {
  const { roomId } = socket.data;
  if (!roomId || !rooms.has(roomId)) {
    return;
  }

  removeMemberFromRoom(roomId, socket.id, true);
}

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, userName, participantKey }) => {
    if (!roomId || !userName || !participantKey) {
      socket.emit("room-error", {
        message: "Faltan datos para entrar a la sala."
      });
      return;
    }

    removeSocketFromRoom(socket);

    const room = getRoomState(roomId);
    const duplicatedMember = Array.from(room.members.values()).find((member) => member.participantKey === participantKey);
    if (duplicatedMember) {
      removeMemberFromRoom(roomId, duplicatedMember.id, true);
    }

    let role = "";
    if (!room.teacherKey) {
      room.teacherKey = participantKey;
      role = "teacher";
    } else if (room.teacherKey === participantKey) {
      role = "teacher";
    } else if (!room.studentKey) {
      room.studentKey = participantKey;
      role = "student";
    } else if (room.studentKey === participantKey) {
      role = "student";
    } else {
      socket.emit("room-error", {
        message: "Esta sala ya tiene un maestro y un estudiante."
      });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.userName = userName;
    socket.data.role = role;
    socket.data.participantKey = participantKey;

    room.members.set(socket.id, {
      id: socket.id,
      name: userName,
      role,
      participantKey
    });

    socket.emit("room-joined", {
      roomId,
      participantId: socket.id,
      role,
      participants: serializeMembers(room),
      boardDataUrl: room.boardDataUrl,
      exerciseContent: room.exerciseContent,
      challenge: room.challenge
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

  socket.on("chat-message", ({ roomId, userName, message }, callback) => {
    if (!roomId || !message) {
      if (typeof callback === "function") {
        callback({
          ok: false,
          message: "Faltan datos para enviar el mensaje."
        });
      }
      return;
    }

    io.to(roomId).emit("chat-message", {
      participantId: socket.id,
      userName,
      message,
      createdAt: new Date().toISOString()
    });

    if (typeof callback === "function") {
      callback({ ok: true });
    }
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

  socket.on("challenge-update", ({ roomId, challenge }) => {
    if (!roomId || !rooms.has(roomId)) {
      return;
    }

    const room = rooms.get(roomId);
    room.challenge = {
      active: Boolean(challenge?.active),
      endsAt: Number(challenge?.endsAt || 0),
      durationSeconds: Number(challenge?.durationSeconds || 0),
      label: challenge?.label || ""
    };

    io.to(roomId).emit("challenge-update", {
      challenge: room.challenge
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
  loadBaldorReference().then((state) => {
    if (state.available) {
      console.log("Referencia Baldor cargada desde PDF local.");
      return;
    }

    if (state.error) {
      console.log(`Referencia Baldor no disponible: ${state.error}`);
    }
  });
});
