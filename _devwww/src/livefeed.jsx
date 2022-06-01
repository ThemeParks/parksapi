import socketIOClient from "socket.io-client";
import {useEffect, useState} from "react";

const LiveFeed = () => {
  const [lastDataTime, setLastDataTime] = useState(0);
  const [data, setData] = useState([]);

  useEffect(() => {
    const socket = socketIOClient('http://localhost:3001');
    socket.on("livedata", (data) => {
      setData((prev) => {
        while (prev.length >= 100) {
          prev.pop();
        }
        // console.log(data.data);
        prev.unshift({
          time: data.time,
          data: JSON.parse(data.data),
        });
        prev.sort((a, b) => b.time - a.time);
        setLastDataTime(Math.max(data.time, lastDataTime));

        // return a new object, so React knows it has changed
        return JSON.parse(JSON.stringify(prev.filter((x, idx, arr) => {
          return idx === 0 || x.time !== arr[idx - 1].time;
        })));
      });
    });

    // disconnect when we leave this component
    return () => {
      socket.disconnect();
    };
  }, []);

  return (
    <div>
      <h1>Live Feed</h1>
      <table>
        <thead>
          <tr>
            <th>time</th>
            <th>id</th>
            <th>type</th>
            <th>method</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.time}>
              <td>{d.time}</td>
              <td>{d.data.id}</td>
              <td>{d.data.type}</td>
              <td>{d.data.method}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default LiveFeed;
