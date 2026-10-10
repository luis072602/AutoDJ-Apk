package co.autodj.app;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import org.schabi.newpipe.extractor.InfoItem;
import org.schabi.newpipe.extractor.ListExtractor;
import org.schabi.newpipe.extractor.MediaFormat;
import org.schabi.newpipe.extractor.NewPipe;
import org.schabi.newpipe.extractor.Page;
import org.schabi.newpipe.extractor.ServiceList;
import org.schabi.newpipe.extractor.StreamingService;
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException;
import org.schabi.newpipe.extractor.localization.ContentCountry;
import org.schabi.newpipe.extractor.localization.Localization;
import org.schabi.newpipe.extractor.playlist.PlaylistInfo;
import org.schabi.newpipe.extractor.search.SearchInfo;
import org.schabi.newpipe.extractor.services.youtube.linkHandler.YoutubeSearchQueryHandlerFactory;
import org.schabi.newpipe.extractor.stream.AudioStream;
import org.schabi.newpipe.extractor.stream.AudioTrackType;
import org.schabi.newpipe.extractor.stream.DeliveryMethod;
import org.schabi.newpipe.extractor.stream.StreamInfo;
import org.schabi.newpipe.extractor.stream.StreamInfoItem;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;

/**
 * El «servidor» de la app: atiende las rutas /api/… que pide la interfaz.
 *
 *   /api/search?q=…      canciones que coinciden con la búsqueda
 *   /api/playlist?url=…  canciones de una lista (o una sola canción) a partir de su enlace
 *   /api/audio?v=ID      el audio de una canción, que se guarda en la caché del teléfono
 *   /api/latest          la última versión publicada de la app, para avisar de actualizaciones
 *
 * Los datos de YouTube los saca NewPipeExtractor. Cuando YouTube cambia algo y esto deja de
 * funcionar, casi siempre basta con subir la versión de esa librería en app/build.gradle.
 */
final class YouTube {
    private static final String TAG = "AutoDJ";
    private static final Pattern VIDEO_ID = Pattern.compile("^[\\w-]{11}$");
    private static final Pattern ID_IN_URL = Pattern.compile("(?:[?&]v=|youtu\\.be/|/shorts/)([\\w-]{11})");
    private static final long CHUNK = 1 << 20;             // se descarga por trozos de 1 MB: de un tirón YouTube lo frena
    private static final long CACHE_MAX = 400L << 20;      // 400 MB de audio guardado; al pasarse se borra lo más viejo
    private static final String VERSION_URL =
            "https://github.com/luis072602/AutoDJ-Apk/releases/latest/download/version.txt";
    private static final int MAX_PAGES = 5;                // páginas extra de una lista (~100 canciones cada una)

    private final File dir;
    private final OkHttpClient http;
    private final ConcurrentHashMap<String, Object> locks = new ConcurrentHashMap<>();

    YouTube(File cacheDir) {
        dir = new File(cacheDir, "audio");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        http = new OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .build();
        NewPipe.init(new OkDownloader(http), new Localization("es", "CO"), new ContentCountry("CO"));
    }

    // ---------- Rutas ----------

    WebResourceResponse handle(Uri u) {
        try {
            String path = u.getPath() == null ? "" : u.getPath();
            switch (path) {
                case "/api/ping":
                    return json(200, new JSONObject().put("ok", true));
                case "/api/latest":
                    return json(200, new JSONObject().put("latest", latestVersion()));
                case "/api/search":
                    return json(200, search(param(u, "q")));
                case "/api/playlist":
                    return json(200, playlist(param(u, "url")));
                case "/api/audio": {
                    String id = param(u, "v");
                    if (!VIDEO_ID.matcher(id).matches()) return error(400, "Identificador de video inválido");
                    return file(audio(id));
                }
                default:
                    return error(404, "No existe");
            }
        } catch (Throwable e) {   // la librería falla de muchas formas; la interfaz solo necesita el motivo
            Log.w(TAG, "Fallo en " + u, e);
            return error(502, explain(e));
        }
    }

    private static String param(Uri u, String name) {
        String v = u.getQueryParameter(name);
        return v == null ? "" : v.trim();
    }

    // ---------- Actualizaciones ----------

    /** Versión más reciente publicada, por ejemplo «0.1.9»: la escribe el flujo de GitHub junto al APK. */
    private String latestVersion() throws IOException {
        Request rq = new Request.Builder().url(VERSION_URL).header("Cache-Control", "no-cache").build();
        try (Response r = http.newCall(rq).execute()) {
            if (!r.isSuccessful() || r.body() == null) throw new IOException("GitHub respondió " + r.code());
            String v = r.body().string().trim();
            if (!v.matches("[0-9.]{1,20}")) throw new IOException("Versión publicada ilegible");
            return v;
        }
    }

    // ---------- Búsqueda y listas ----------

    private JSONObject search(String query) throws Exception {
        if (query.isEmpty()) throw new IllegalArgumentException("Escribe qué quieres buscar");
        StreamingService yt = ServiceList.YouTube;
        JSONArray items = new JSONArray();
        // Primero el catálogo de YouTube Music (canciones con su artista); si no hay nada, videos normales
        List<String> filters = Arrays.asList(
                YoutubeSearchQueryHandlerFactory.MUSIC_SONGS, YoutubeSearchQueryHandlerFactory.VIDEOS);
        Exception last = null;
        for (String filter : filters) {
            try {
                SearchInfo info = SearchInfo.getInfo(yt,
                        yt.getSearchQHFactory().fromQuery(query, Collections.singletonList(filter), ""));
                add(items, info.getRelatedItems());
            } catch (Exception e) {
                last = e;
            }
            if (items.length() > 0) break;
        }
        if (items.length() == 0 && last != null) throw last;
        return new JSONObject().put("items", items);
    }

    private JSONObject playlist(String url) throws Exception {
        StreamingService yt = ServiceList.YouTube;
        JSONArray items = new JSONArray();
        String title;
        StreamingService.LinkType type = yt.getLinkTypeByUrl(url);
        if (type == StreamingService.LinkType.PLAYLIST) {
            PlaylistInfo info = PlaylistInfo.getInfo(yt, url);
            title = info.getName();
            add(items, info.getRelatedItems());
            Page next = info.getNextPage();
            for (int n = 0; next != null && n < MAX_PAGES; n++) {
                ListExtractor.InfoItemsPage<StreamInfoItem> page = PlaylistInfo.getMoreItems(yt, url, next);
                add(items, page.getItems());
                next = page.getNextPage();
            }
        } else if (type == StreamingService.LinkType.STREAM) {
            StreamInfo info = StreamInfo.getInfo(yt, url);
            title = info.getName();
            items.put(item(info.getId(), info.getName(), info.getUploaderName(), info.getDuration()));
        } else {
            throw new IllegalArgumentException("Pega el enlace de una canción o de una lista de YouTube");
        }
        return new JSONObject().put("title", title).put("items", items);
    }

    private static void add(JSONArray out, List<? extends InfoItem> list) throws JSONException {
        for (InfoItem it : list) {
            if (!(it instanceof StreamInfoItem)) continue;
            StreamInfoItem s = (StreamInfoItem) it;
            Matcher m = ID_IN_URL.matcher(s.getUrl() == null ? "" : s.getUrl());
            if (m.find()) out.put(item(m.group(1), s.getName(), s.getUploaderName(), s.getDuration()));
        }
    }

    private static JSONObject item(String id, String title, String artist, long seconds) throws JSONException {
        String t = title == null ? "" : title;
        String a = artist == null ? "" : artist.replaceAll(" - Topic$", "");
        String name = a.isEmpty() || t.toLowerCase().contains(a.toLowerCase()) ? t : a + " - " + t;
        return new JSONObject().put("vid", id).put("name", name).put("len", seconds);
    }

    // ---------- Audio ----------

    /** Devuelve el archivo de audio de un video, descargándolo si no está en la caché. */
    private File audio(String id) throws Exception {
        Object lock = locks.computeIfAbsent(id, k -> new Object());
        synchronized (lock) {
            for (String ext : new String[]{"m4a", "webm"}) {
                File hit = new File(dir, id + "." + ext);
                if (hit.isFile() && hit.length() > 0) {
                    //noinspection ResultOfMethodCallIgnored
                    hit.setLastModified(System.currentTimeMillis());
                    return hit;
                }
            }
            StreamInfo info = StreamInfo.getInfo(ServiceList.YouTube, "https://www.youtube.com/watch?v=" + id);
            AudioStream best = null;
            for (AudioStream a : info.getAudioStreams()) {
                if (!a.isUrl() || a.getDeliveryMethod() != DeliveryMethod.PROGRESSIVE_HTTP) continue;
                if (best == null || score(a) > score(best)) best = a;
            }
            if (best == null) throw new IOException("YouTube no entregó el audio de esta canción");

            File part = new File(dir, id + ".part");
            File out = new File(dir, id + (best.getFormat() == MediaFormat.M4A ? ".m4a" : ".webm"));
            download(best.getContent(), part);
            if (!part.renameTo(out)) throw new IOException("No se pudo guardar el audio");
            prune(out);
            return out;
        }
    }

    // Se prefiere la pista original (YouTube ofrece doblajes automáticos), luego m4a y un bitrate normal
    private static int score(AudioStream a) {
        AudioTrackType type = a.getAudioTrackType();
        int s = type == null || type == AudioTrackType.ORIGINAL ? 100000 : 0;
        s += Math.min(Math.max(a.getAverageBitrate(), 0), 160) * 10;
        if (a.getFormat() == MediaFormat.M4A) s += 5;
        return s;
    }

    private void download(String url, File to) throws IOException {
        long pos = 0;
        try (OutputStream os = new FileOutputStream(to)) {
            byte[] buf = new byte[64 * 1024];
            while (true) {
                Request rq = new Request.Builder().url(url)
                        .header("User-Agent", OkDownloader.USER_AGENT)
                        .header("Range", "bytes=" + pos + "-" + (pos + CHUNK - 1))
                        .build();
                try (Response r = http.newCall(rq).execute()) {
                    if (r.code() == 416) break;   // ya no queda nada por pedir
                    if (!r.isSuccessful() || r.body() == null) throw new IOException("YouTube respondió " + r.code());
                    long got = 0;
                    try (InputStream in = r.body().byteStream()) {
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            os.write(buf, 0, n);
                            got += n;
                        }
                    }
                    pos += got;
                    if (r.code() == 200) break;   // ignoró el rango y lo mandó entero
                    long total = totalOf(r.header("Content-Range"));
                    if (got == 0 || (total > 0 ? pos >= total : got < CHUNK)) break;
                }
            }
        }
        if (pos == 0) throw new IOException("La descarga llegó vacía");
    }

    // «bytes 0-1048575/3792397» → 3792397
    private static long totalOf(String contentRange) {
        if (contentRange == null) return -1;
        int slash = contentRange.lastIndexOf('/');
        try {
            return slash < 0 ? -1 : Long.parseLong(contentRange.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private void prune(File keep) {
        File[] files = dir.listFiles();
        if (files == null) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        long total = 0;
        for (File f : files) total += f.length();
        for (File f : files) {
            if (total <= CACHE_MAX) break;
            if (f.equals(keep) || f.getName().endsWith(".part")) continue;
            total -= f.length();
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    // ---------- Respuestas ----------

    private static WebResourceResponse json(int status, JSONObject body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse("application/json", "utf-8", status, status == 200 ? "OK" : "Error",
                headers, new ByteArrayInputStream(bytes));
    }

    private static WebResourceResponse error(int status, String message) {
        try {
            return json(status, new JSONObject().put("error", message));
        } catch (JSONException e) {
            return json(status, new JSONObject());
        }
    }

    private static WebResourceResponse file(File f) throws IOException {
        Map<String, String> headers = new HashMap<>();
        headers.put("Content-Length", String.valueOf(f.length()));
        headers.put("Cache-Control", "no-store");
        String mime = f.getName().endsWith(".m4a") ? "audio/mp4" : "audio/webm";
        return new WebResourceResponse(mime, null, 200, "OK", headers, new FileInputStream(f));
    }

    private static String explain(Throwable e) {
        if (e instanceof ReCaptchaException) return "YouTube pide una verificación; espera unos minutos e intenta de nuevo";
        if (e instanceof IllegalArgumentException && e.getMessage() != null) return e.getMessage();
        if (e instanceof java.net.UnknownHostException || e instanceof java.net.SocketTimeoutException
                || e instanceof java.net.ConnectException) return "Sin conexión a internet";
        String kind = e.getClass().getSimpleName();
        if (kind.contains("AgeRestricted")) return "Canción con restricción de edad";
        if (kind.contains("GeographicRestriction")) return "Canción no disponible en tu país";
        if (kind.contains("Private") || kind.contains("ContentNotAvailable")) return "Canción no disponible";
        if (kind.contains("SignIn") || kind.contains("Login")) return "YouTube pide iniciar sesión para esta canción";
        String msg = e.getMessage() == null ? kind : e.getMessage();
        return msg.length() > 140 ? msg.substring(0, 140) : msg;
    }
}
