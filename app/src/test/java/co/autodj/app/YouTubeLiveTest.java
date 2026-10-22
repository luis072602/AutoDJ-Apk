package co.autodj.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Assume;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

/**
 * Prueba real contra YouTube: hace lo mismo que la app cuando buscas y reproduces una canción.
 * Corre en GitHub antes de publicar cada versión, y cada semana con la versión nueva de NewPipe Extractor.
 *
 * Deja el resultado en el archivo que indica «autodj.youtube.result»:
 *   ok          YouTube funciona
 *   roto: …     YouTube cambió algo y la app ya no puede buscar o descargar (la prueba falla)
 *   bloqueado:… YouTube pidió verificar que no somos un robot (pasa con los servidores de GitHub);
 *               no dice nada de la app, así que la prueba queda «saltada», no fallida
 */
public class YouTubeLiveTest {
    // Canción que lleva años publicada y no tiene restricciones: si falla, el problema no es la canción
    private static final String SONG = "dQw4w9WgXcQ";

    @Test
    public void youtubeSigueFuncionando() throws Throwable {
        String step = "iniciar";
        try {
            YouTube yt = new YouTube(Files.createTempDirectory("autodj-prueba").toFile());

            step = "buscar canciones";
            JSONArray items = yt.search("Daft Punk One More Time").getJSONArray("items");
            assertTrue("La búsqueda no trajo canciones", items.length() >= 3);
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                assertTrue("Identificador de video raro: " + it, it.getString("vid").matches("[\\w-]{11}"));
                assertTrue("Canción sin nombre: " + it, !it.getString("name").isEmpty());
            }

            step = "leer el enlace de una canción";
            JSONObject one = yt.playlist("https://www.youtube.com/watch?v=" + SONG);
            assertEquals("El enlace no trajo exactamente una canción", 1, one.getJSONArray("items").length());
            assertTrue("La canción del enlace no tiene título", !one.getString("title").isEmpty());

            step = "descargar el audio";
            File audio = yt.audio(SONG);
            assertTrue("El audio pesa muy poco: " + audio.length() + " bytes", audio.length() > 1_000_000);
            assertTrue("El archivo descargado no es audio", isAudio(audio));

            write("ok");
            System.out.println("YouTube funciona: " + items.length() + " resultados y " + audio.length() / 1024 + " KB de audio");
        } catch (Throwable e) {
            String why = step + ": " + describe(e);
            if (blocked(e)) {
                write("bloqueado: " + why);
                Assume.assumeTrue("YouTube pidió verificación (" + why + ")", false);
            }
            write("roto: " + why);
            throw e;
        }
    }

    // m4a empieza con «ftyp» en el byte 4; webm con 1A 45 DF A3
    private static boolean isAudio(File f) throws Exception {
        byte[] h = new byte[12];
        try (InputStream in = new FileInputStream(f)) {
            if (in.read(h) < 12) return false;
        }
        boolean m4a = new String(h, 4, 4, StandardCharsets.US_ASCII).equals("ftyp");
        boolean webm = (h[0] & 0xff) == 0x1A && (h[1] & 0xff) == 0x45 && (h[2] & 0xff) == 0xDF && (h[3] & 0xff) == 0xA3;
        return m4a || webm;
    }

    // ¿El fallo es que YouTube no quiere atender a este servidor (y no que la app esté rota)?
    private static boolean blocked(Throwable e) {
        for (Throwable c = e; c != null; c = c.getCause()) {
            String kind = c.getClass().getSimpleName(), msg = String.valueOf(c.getMessage()).toLowerCase();
            if (kind.contains("ReCaptcha") || kind.contains("NotBot") || kind.contains("SignIn")) return true;
            if (msg.contains("not a bot") || msg.contains("sign in to confirm") || msg.contains("429")) return true;
        }
        return false;
    }

    private static String describe(Throwable e) {
        StringBuilder s = new StringBuilder();
        for (Throwable c = e; c != null && s.length() < 400; c = c.getCause())
            s.append(s.length() > 0 ? " ← " : "").append(c.getClass().getSimpleName()).append(": ").append(c.getMessage());
        return s.toString().replace('\n', ' ');
    }

    private static void write(String result) {
        String path = System.getProperty("autodj.youtube.result");
        if (path == null) return;
        try {
            Files.write(new File(path).toPath(), result.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }
}
